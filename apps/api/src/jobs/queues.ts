import { readFileSync } from 'node:fs'
import type { JobsOptions, RedisOptions } from 'bullmq'
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

