import { Queue, type RedisOptions } from 'bullmq'
import type { Knex } from 'knex'
import type { Logger } from 'pino'
import { getValidator, type Static, type TObject } from '@feathersjs/typebox'
import {
  MAIL_JOB_OPTIONS,
  MAIL_QUEUE,
  MAINTENANCE_QUEUE,
  QUEUE_PREFIX,
  RESOLVE_CAMPAIGN,
  SEND_MAIL,
  type CampaignJob,
  type MailJob
} from '../jobs/queues.js'
import { currentRequest } from '../request-context.js'
import { dataValidator } from '../validators.js'
import type { NotificationKind } from './kind.js'
import { getMailKind } from './registry.js'

// The transactional outbox of mail (ADR 0024, 0027). A notification is a
// `pending` row of mail_deliveries, written in the transaction of the write
// that causes it: it exists exactly when that write commits. After the
// commit its job is enqueued, with the delivery's id as the job id; the
// sweep enqueues what is still pending a minute later, so a lost enqueue is
// only a delay.

export const SWEEP_AFTER_SECONDS = 60
export const SWEEP_BATCH_SIZE = 1000

export class MailError extends Error {}

const validators = new WeakMap<TObject, ReturnType<typeof getValidator>>()
const validatorFor = (schema: TObject) => {
  let validate = validators.get(schema)
  if (!validate) {
    validate = getValidator(schema, dataValidator)
    validators.set(schema, validate)
  }
  return validate
}

// Resolving a campaign's recipients: a few retries, on the maintenance
// queue, since the mail queue's rate limit would count it.
export const CAMPAIGN_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 }
}

export class MailOutbox {
  readonly queue: Queue<MailJob>
  readonly campaigns: Queue<CampaignJob>

  constructor(
    connection: RedisOptions,
    private readonly logger: Logger,
    prefix = QUEUE_PREFIX
  ) {
    this.queue = new Queue<MailJob>(MAIL_QUEUE, { connection, prefix, defaultJobOptions: MAIL_JOB_OPTIONS })
    this.campaigns = new Queue<CampaignJob>(MAINTENANCE_QUEUE, { connection, prefix })
  }

  // Hands a committed campaign to the worker, which resolves its recipients.
  async enqueueCampaign(campaignId: string, requestId = currentRequest()?.requestId): Promise<void> {
    await this.campaigns.add(RESOLVE_CAMPAIGN, { campaignId, requestId }, { ...CAMPAIGN_JOB_OPTIONS, jobId: campaignId })
  }

  // Mails `kind` to `userId` once `trx` commits, and never if it rolls back.
  // `params` hold surrogate ids, never direct identifiers or rendered text.
  // Takes a transaction of the camelCase Knex. Returns the delivery's id.
  async notify<P extends TObject, V extends TObject>(
    trx: Knex.Transaction,
    kind: NotificationKind<P, V>,
    userId: string,
    params: Static<P>
  ): Promise<string> {
    if (getMailKind(kind.key) !== (kind as unknown)) throw new MailError(`mail kind ${kind.key} is not registered`)
    try {
      await validatorFor(kind.params)(params)
    } catch (error) {
      throw new MailError(`mail kind ${kind.key}: invalid params: ${JSON.stringify((error as { data?: unknown }).data ?? error)}`)
    }
    const [row]: { id: string }[] = await trx('mailDeliveries')
      .insert({ userId, kind: kind.key, params: JSON.stringify(params) })
      .returning('id')
    const deliveryId = row!.id
    const requestId = currentRequest()?.requestId
    // Rejected on rollback, when there is nothing to send.
    trx.executionPromise.then(
      () =>
        this.enqueue([deliveryId], requestId).catch((error: Error) =>
          this.logger.warn({ delivery_id: deliveryId, err: { message: error.message } }, 'mail not enqueued; the sweep will')
        ),
      () => undefined
    )
    return deliveryId
  }

  async enqueue(deliveryIds: readonly string[], requestId?: string): Promise<void> {
    if (deliveryIds.length === 0) return
    await this.queue.addBulk(
      deliveryIds.map((deliveryId) => ({ name: SEND_MAIL, data: { deliveryId, requestId }, opts: { jobId: deliveryId } }))
    )
  }

  // Enqueues deliveries, and campaigns, pending for more than a minute. A
  // job that still exists deduplicates by its id; one that finished while
  // its row is still pending (it could not even record its failure) runs
  // again.
  async sweep(knex: Knex, batchSize = SWEEP_BATCH_SIZE): Promise<number> {
    const campaigns = await knex('mailCampaigns')
      .where({ status: 'pending' })
      .where('createdAt', '<', knex.raw('now() - make_interval(secs => ?)', [SWEEP_AFTER_SECONDS]))
      .orderBy('createdAt')
      .limit(batchSize)
      .pluck<string[]>('id')
    let swept = 0
    for (const id of campaigns) {
      if (!(await this.lost(this.campaigns, id))) continue
      await this.enqueueCampaign(id, undefined)
      swept++
    }
    const ids = await knex('mailDeliveries')
      .where({ status: 'pending' })
      .where('createdAt', '<', knex.raw('now() - make_interval(secs => ?)', [SWEEP_AFTER_SECONDS]))
      .orderBy('createdAt')
      .limit(batchSize)
      .pluck<string[]>('id')
    const missing: string[] = []
    for (const id of ids) if (await this.lost(this.queue, id)) missing.push(id)
    await this.enqueue(missing)
    return swept + missing.length
  }

  // Whether a pending row's job is gone or finished; a finished one is
  // removed, so it can be added again.
  private async lost(queue: Queue, id: string): Promise<boolean> {
    const job = await queue.getJob(id)
    if (!job) return true
    const state = await job.getState()
    if (state !== 'completed' && state !== 'failed') return false
    await job.remove()
    return true
  }

  async close(): Promise<void> {
    await Promise.all([this.queue.close(), this.campaigns.close()])
  }
}
