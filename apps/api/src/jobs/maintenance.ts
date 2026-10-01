import { Queue, UnrecoverableError, Worker, type JobsOptions, type RedisOptions } from 'bullmq'
import type { Knex } from 'knex'
import type { Logger } from 'pino'
import { Counter, Gauge, Histogram, type Registry } from '@prometheus-io/client'
import type { SettingsStore } from '../settings/store.js'
import type { Storage } from '../storage.js'
import { buildExport } from '../gdpr/export.js'
import { resolveCampaign } from '../mail/campaigns.js'
import { PermanentMailFailure, deliver } from '../mail/deliver.js'
import { MailOutbox } from '../mail/outbox.js'
import type { MailSender } from '../mail/sender.js'
import {
  BUILD_EXPORT,
  DATA_EXPORTS_QUEUE,
  EXPORT_JOB_OPTIONS,
  MAIL_QUEUE,
  MAINTENANCE_QUEUE,
  QUEUE_PREFIX,
  RESOLVE_CAMPAIGN,
  SEND_MAIL,
  UPDATE_CHECK,
  UPDATE_CHECK_ON_START_ID,
  type CampaignJob,
  type ExportJob,
  type MailJob
} from './queues.js'
import { exportExpiry } from './export-expiry.js'
import { objectPurge } from './object-purge.js'
import { retentionCleanup } from './retention.js'
import type { Labels } from '../system/prometheus.js'
import { COMPONENT_UPDATES_TABLE, runUpdateCheck } from '../system/update-check.js'
import { observeUpdates } from '../system/update-metrics.js'
import type { UpdateSources } from '../system/update-sources.js'

// The worker's queues and their workers (ADR 0024): `maintenance`, whose
// recurring jobs are job schedulers, so a schedule exists once in Valkey
// however many workers run; and `data-exports`, filled by the api on request
// (ADR 0013).

export { BUILD_EXPORT, DATA_EXPORTS_QUEUE, MAINTENANCE_QUEUE, QUEUE_PREFIX, UPDATE_CHECK, queueConnection } from './queues.js'

export const RETENTION_CLEANUP = 'retention-cleanup'
export const OBJECT_PURGE = 'object-purge'
export const EXPORT_EXPIRY = 'export-expiry'
// The check for newer versions (ADR 0032) runs once at start when the last
// result is older than this.
export const UPDATE_CHECK_STALE_MS = 24 * 60 * 60 * 1000
// The mail outbox's sweep (ADR 0027): every minute, one attempt; the next
// run is the retry.
export const MAIL_SWEEP = 'mail-sweep'
export const MAIL_SWEEP_EVERY = { every: 60_000 }
export const MAIL_SWEEP_OPTIONS: JobsOptions = { attempts: 1, removeOnComplete: { count: 10 }, removeOnFail: { count: 100 } }

// Daily jobs run at night, local time (ADR 0024).
export const DAILY = { pattern: '30 3 * * *', tz: 'Europe/Berlin' }

// Retried with backoff; the last failure is logged at `error`, which the
// Loki error alert picks up (ADR 0022). A bounded history stays in Valkey.
export const JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 }
}

// A lost Valkey connection is transient: the client reconnects, and an
// outage that lasts alerts as "API not ready" (ADR 0022). At `error` every
// Valkey restart would fire the Loki error alert, so it logs at `warn`, as
// the api does.
const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'EPIPE'])
// ioredis gives up on a command after its retries while disconnected.
export const isConnectionError = (error: Error) =>
  CONNECTION_ERRORS.has((error as NodeJS.ErrnoException).code ?? '') || error.name === 'MaxRetriesPerRequestError'

export interface MaintenanceOptions {
  connection: RedisOptions
  knex: Knex
  settings: SettingsStore
  // The uploads bucket, and the exports bucket (ADR 0013, 0020).
  storage: Storage
  exports: Storage
  logger: Logger
  // Tests keep their queues apart.
  prefix?: string
  // Job outcomes, durations and queue depth (ADR 0022).
  metrics?: Registry
  // Sending mail (ADR 0027): the SMTP server and the origin links start
  // with. Without it, deliveries wait in the mail queue for a worker that
  // has one.
  mail?: { sender: MailSender; publicOrigin: string }
  // The update check's sources (ADR 0032); without them it is off, its
  // schedule removed and its metrics not exported.
  updateCheck?: { sources: UpdateSources; hostOs: () => Promise<Labels | null> }
}

// How often the worker re-reads the sending limit; a change applies to
// every worker process at once, since the limit lives in the queue.
export const MAIL_LIMIT_REFRESH_MS = 30_000
// How often the worker looks whether maintenance mode is on (ADR 0025).
export const MAINTENANCE_MODE_REFRESH_MS = 15_000

export const startMaintenance = ({
  connection,
  knex,
  settings,
  storage,
  exports,
  logger,
  prefix = QUEUE_PREFIX,
  metrics,
  mail: sending,
  updateCheck
}: MaintenanceOptions) => {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix, defaultJobOptions: JOB_OPTIONS })
  const exportQueue = new Queue<ExportJob>(DATA_EXPORTS_QUEUE, { connection, prefix, defaultJobOptions: EXPORT_JOB_OPTIONS })
  // Notifications the worker causes, and the sweep.
  const mail = new MailOutbox(connection, logger, prefix)
  const queues = [queue, exportQueue, mail.queue] as Queue[]
  const registers = metrics ? [metrics] : []
  const outcomes = new Counter({
    name: 'bullmq_jobs_total',
    help: 'Finished job attempts by outcome',
    labelNames: ['queue', 'outcome'],
    registers
  })
  const durations = new Histogram({
    name: 'bullmq_job_duration_seconds',
    help: 'Duration of job attempts, from start to finish',
    labelNames: ['queue'],
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600],
    registers
  })
  new Gauge({
    name: 'bullmq_queue_jobs',
    help: 'Jobs in the queue by state',
    labelNames: ['queue', 'state'],
    registers,
    async collect() {
      for (const each of queues) {
        const counts = await each.getJobCounts('waiting', 'active', 'delayed', 'failed')
        for (const [state, count] of Object.entries(counts)) this.set({ queue: each.name, state }, count)
      }
    }
  })

  if (metrics && updateCheck) observeUpdates(metrics, knex)

  // Logs and counts what a worker's jobs do.
  const observe = (worker: Worker) => {
    const name = worker.name
    const finished = (job: { processedOn?: number; finishedOn?: number } | undefined, outcome: string) => {
      outcomes.inc({ queue: name, outcome })
      if (job?.processedOn && job.finishedOn) {
        durations.observe({ queue: name }, (job.finishedOn - job.processedOn) / 1000)
      }
    }
    worker.on('completed', (job, result: unknown) => {
      finished(job, 'completed')
      // Every minute: only worth a line when it found something.
      if (job.name === MAIL_SWEEP && result === 0) return
      logger.info({ queue: name, job: job.name, job_id: job.id, request_id: (job.data as { requestId?: string } | undefined)?.requestId, result }, 'job completed')
    })
    worker.on('failed', (job, error) => {
      const final = !job || error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1)
      finished(job, final ? 'failed' : 'retried')
      logger[final ? 'error' : 'warn'](
        {
          queue: name,
          job: job?.name,
          job_id: job?.id,
          request_id: (job?.data as { requestId?: string } | undefined)?.requestId,
          attempt: job?.attemptsMade,
          err: { message: error.message }
        },
        final ? 'job failed' : 'job failed, will retry'
      )
    })
    worker.on('error', (error) =>
      logger[isConnectionError(error) ? 'warn' : 'error']({ queue: name, err: { message: error.message } }, 'worker error')
    )
    return worker
  }

  const worker = observe(
    new Worker(
      MAINTENANCE_QUEUE,
      async (job) => {
        switch (job.name) {
          case RETENTION_CLEANUP:
            return retentionCleanup(knex, settings)
          case OBJECT_PURGE:
            return objectPurge(knex, settings, storage)
          case EXPORT_EXPIRY:
            return exportExpiry(knex, settings, exports)
          case MAIL_SWEEP:
            return mail.sweep(knex)
          case RESOLVE_CAMPAIGN:
            return resolveCampaign(knex, mail, (job.data as CampaignJob).campaignId)
          case UPDATE_CHECK:
            // A job queued before the check was switched off.
            if (!updateCheck) return 'off'
            return runUpdateCheck({ knex, logger, ...updateCheck })
          default:
            throw new UnrecoverableError(`unknown job ${job.name}`)
        }
      },
      { connection, prefix, concurrency: 1 }
    )
  )

  // One export at a time: each holds a part of the zip in memory and reads
  // the uploads bucket. Its last failed attempt marks the export failed, so
  // the requester sees it and may ask again.
  const exportWorker = observe(
    new Worker<ExportJob>(
      DATA_EXPORTS_QUEUE,
      async (job) => {
        if (job.name !== BUILD_EXPORT) throw new UnrecoverableError(`unknown job ${job.name}`)
        try {
          const result = await buildExport({ knex, uploads: storage, exports, exportId: job.data.exportId, mail })
          // Built all the same, but the object store lost data: at `error`,
          // for the log alert (ADR 0022).
          if (result.missingFiles) {
            logger.error(
              { queue: DATA_EXPORTS_QUEUE, export_id: result.exportId, file_ids: result.missingFiles },
              'export built without files whose objects are missing'
            )
          }
          return result
        } catch (error) {
          if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
            await knex('dataExports')
              .where({ id: job.data.exportId, state: 'pending' })
              .update({ state: 'failed', completedAt: knex.fn.now() })
          }
          throw error
        }
      },
      { connection, prefix, concurrency: 1 }
    )
  )

  // Mail (ADR 0027): one delivery per job, one at a time per process,
  // throttled across all processes by the queue's global rate limit, which
  // follows the runtime settings. A skipped delivery takes its slot too.
  const mailed = new Counter({
    name: 'mail_deliveries_total',
    help: 'Finished mail deliveries by kind and outcome',
    labelNames: ['kind', 'outcome'],
    registers
  })
  let limit = ''
  const applyMailLimit = async () => {
    const [count, windowSeconds] = await Promise.all([
      settings.get('mailSendLimitCount'),
      settings.get('mailSendLimitWindowSeconds')
    ])
    if (limit === `${count}/${windowSeconds}`) return
    await mail.queue.setGlobalRateLimit(count, windowSeconds * 1000)
    limit = `${count}/${windowSeconds}`
    logger.info({ queue: MAIL_QUEUE, count, window_seconds: windowSeconds }, 'mail sending limit applied')
  }
  let limitTimer: NodeJS.Timeout | undefined
  const mailWorker = sending
    ? observe(
        new Worker<MailJob>(
          MAIL_QUEUE,
          async (job) => {
            if (job.name !== SEND_MAIL) throw new UnrecoverableError(`unknown job ${job.name}`)
            try {
              const outcome = await deliver({
                knex,
                sender: sending.sender,
                publicOrigin: sending.publicOrigin,
                logger,
                deliveryId: job.data.deliveryId,
                attempt: job.attemptsMade + 1,
                attempts: job.opts.attempts ?? 1
              })
              if (outcome.status !== 'done') mailed.inc({ kind: outcome.kind, outcome: outcome.status })
              return outcome
            } catch (error) {
              if (!(error instanceof PermanentMailFailure)) throw error
              mailed.inc({ kind: error.kind, outcome: 'failed' })
              throw new UnrecoverableError(error.message)
            }
          },
          { connection, prefix, concurrency: 1, autorun: false }
        )
      )
    : undefined

  // Maintenance mode stops all job processing (ADR 0025): each worker
  // finishes the job it has and takes no further one until the mode is off.
  // Jobs wait in their queues meanwhile, schedules included.
  const workers = [worker, exportWorker, ...(mailWorker ? [mailWorker] : [])]
  let paused = false
  let applying: Promise<void> | undefined
  const applyMaintenanceMode = (): Promise<void> =>
    (applying ??= (async () => {
      settings.forget('maintenanceMode')
      const active = await settings.get('maintenanceMode')
      if (active === paused) return
      if (active) {
        logger.warn('maintenance mode: job processing paused')
        await Promise.all(workers.map((each) => each.pause()))
      } else {
        await Promise.all(workers.map((each) => each.resume()))
        logger.warn('maintenance mode over: job processing resumed')
      }
      paused = active
    })().finally(() => (applying = undefined)))
  let maintenanceTimer: NodeJS.Timeout | undefined

  return {
    queue,
    worker,
    exportQueue,
    exportWorker,
    mail,
    mailWorker,
    applyMailLimit,
    // Creates or updates the schedules; safe to run on every start.
    schedule: async () => {
      for (const name of [RETENTION_CLEANUP, OBJECT_PURGE, EXPORT_EXPIRY]) {
        await queue.upsertJobScheduler(name, DAILY, { name, opts: JOB_OPTIONS })
      }
      await queue.upsertJobScheduler(MAIL_SWEEP, MAIL_SWEEP_EVERY, { name: MAIL_SWEEP, opts: MAIL_SWEEP_OPTIONS })
      if (updateCheck) {
        await queue.upsertJobScheduler(UPDATE_CHECK, DAILY, { name: UPDATE_CHECK, opts: JOB_OPTIONS })
        const latest = await knex(COMPONENT_UPDATES_TABLE).max<{ max: Date | null }>('attemptedAt as max').first()
        if (!latest?.max || Date.now() - new Date(latest.max).getTime() > UPDATE_CHECK_STALE_MS) {
          // One id: workers starting together queue one check. Removed when
          // done, so the id is free for the next stale start.
          await queue.add(
            UPDATE_CHECK,
            {},
            { ...JOB_OPTIONS, jobId: UPDATE_CHECK_ON_START_ID, removeOnComplete: true, removeOnFail: true }
          )
        }
      } else {
        await queue.removeJobScheduler(UPDATE_CHECK)
      }
      if (mailWorker) {
        // The limit is in place before the first mail goes.
        await applyMailLimit()
        limitTimer = setInterval(() => {
          applyMailLimit().catch((error: Error) =>
            logger.warn({ queue: MAIL_QUEUE, err: { message: error.message } }, 'mail sending limit not refreshed')
          )
        }, MAIL_LIMIT_REFRESH_MS)
        limitTimer.unref()
        mailWorker.run().catch((error: Error) =>
          logger.error({ queue: MAIL_QUEUE, err: { message: error.message } }, 'mail worker stopped')
        )
      }
      await applyMaintenanceMode()
      maintenanceTimer = setInterval(() => {
        applyMaintenanceMode().catch((error: Error) =>
          logger.warn({ err: { message: error.message } }, 'maintenance mode not refreshed')
        )
      }, MAINTENANCE_MODE_REFRESH_MS)
      maintenanceTimer.unref()
    },
    applyMaintenanceMode,
    isPaused: () => paused,
    // A paused worker's loop has ended, yet the process is well.
    isRunning: () => workers.every((each) => each.isRunning() || each.isPaused()),
    close: async () => {
      clearInterval(limitTimer)
      clearInterval(maintenanceTimer)
      await Promise.all([worker.close(), exportWorker.close(), mailWorker?.close()])
      sending?.sender.close()
      await Promise.all([queue.close(), exportQueue.close(), mail.close()])
    }
  }
}

export type Maintenance = ReturnType<typeof startMaintenance>
