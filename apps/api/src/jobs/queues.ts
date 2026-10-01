import { readFileSync } from 'node:fs'
import type { JobsOptions, Queue, RedisOptions } from 'bullmq'
import type { ValkeyConfig } from '../config.js'

// What the api and the worker share about the queues (ADR 0024): the api
// enqueues exports and relays their outcome, the worker runs them.

// The default prefix; the worker's and the api's Valkey users may reach
// `bull:*` keys only (ADR 0010), and config.queuePrefix may add a namespace.
export const QUEUE_PREFIX = 'bull'

// GDPR exports, on request (ADR 0013). The job id is the export's id, so an
// export is enqueued once however often it is asked for.
export const DATA_EXPORTS_QUEUE = 'data-exports'
export const BUILD_EXPORT = 'build-export'

export interface ExportJob {
  exportId: string
  // The request that asked for it (ADR 0021, 0024).
  requestId?: string
}

// A few quick retries: someone is waiting for the result.
export const EXPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 }
}

// The worker's recurring jobs, and resolving a campaign's recipients
// (ADR 0024, 0027); job schedulers live in jobs/maintenance.ts.
export const MAINTENANCE_QUEUE = 'maintenance'
export const RESOLVE_CAMPAIGN = 'resolve-campaign'

// The check for newer versions (ADR 0032), on the maintenance queue: daily
// from a job scheduler, once at the worker's start when the last result is
// stale, and when an admin asks for one. An asked-for check has one id, so
// two clicks queue one; it runs once, and the next daily run is its retry.
export const UPDATE_CHECK = 'update-check'
export const UPDATE_CHECK_ON_START_ID = `${UPDATE_CHECK}-on-start`
export const UPDATE_CHECK_ASKED_ID = `${UPDATE_CHECK}-asked`
export const UPDATE_CHECK_ASKED_OPTIONS: JobsOptions = { jobId: UPDATE_CHECK_ASKED_ID, attempts: 1, removeOnComplete: true, removeOnFail: true }

// Whether a job id is one of the update check's; BullMQ names a scheduler's
// jobs `repeat:<scheduler>:<due time>`.
export const isUpdateCheckJob = (jobId: string) =>
  jobId === UPDATE_CHECK_ASKED_ID || jobId === UPDATE_CHECK_ON_START_ID || jobId.startsWith(`repeat:${UPDATE_CHECK}:`)

// Whether a check runs or waits to: one that is active or queued, or
// retrying after a failure. The scheduler's next run, delayed until night
// and not yet attempted, does not count.
export const updateCheckRunning = async (queue: Queue) => {
  const [queued, delayed] = await Promise.all([queue.getJobs(['active', 'waiting', 'prioritized']), queue.getDelayed()])
  // A job removed between listing and reading comes back undefined.
  return (
    queued.some((job) => job?.name === UPDATE_CHECK) || delayed.some((job) => job?.name === UPDATE_CHECK && job.attemptsMade > 0)
  )
}

// The job id is the campaign's id.
export interface CampaignJob {
  campaignId: string
  requestId?: string
}

// Mail (ADR 0027): one job per delivery, on a queue of its own so a large
// campaign never delays the daily jobs or exports. The job id is the
// delivery's id. A temporary SMTP failure is retried with backoff, five
// attempts in all.
export const MAIL_QUEUE = 'mail'
export const SEND_MAIL = 'send-mail'

export interface MailJob {
  deliveryId: string
  requestId?: string
}

export const MAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 1000 }
}

// Every queue, in the order the admin's queue view lists them. A product's
// new queue is added here.
export const QUEUE_NAMES = [MAINTENANCE_QUEUE, DATA_EXPORTS_QUEUE, MAIL_QUEUE] as const

// BullMQ opens its own connections from these options, with the settings
// blocking commands need; the rate limiter's fail-fast connection would not
// do (ADR 0010).
export const queueConnection = (config: ValkeyConfig): RedisOptions => ({
  host: config.valkeyHost,
  port: config.valkeyPort,
  username: config.valkeyUser,
  password: config.valkeyPassword,
  tls: { ca: readFileSync(config.valkeyCaFile, 'utf8'), servername: config.valkeyHost },
  retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000)
})

