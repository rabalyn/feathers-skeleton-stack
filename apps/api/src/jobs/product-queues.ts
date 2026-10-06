import type { Job, JobSchedulerTemplateOptions, JobsOptions, RepeatOptions } from 'bullmq'
import type { Knex } from 'knex'
import type { Logger } from 'pino'
import type { MailOutbox } from '../mail/outbox.js'
import { PRODUCT_QUEUES } from '../product/jobs.js'
import type { SettingsStore } from '../settings/store.js'
import type { Storage } from '../storage.js'
import { QUEUE_NAMES } from './queues.js'

// A product's job queues (ADR 0024, 0035), declared in product/jobs.ts. The
// worker gives each its own BullMQ worker, observed, counted and paused
// under maintenance mode like the skeleton's, and keeps its schedules.

// What a job may use; the same the skeleton's jobs get.
export interface ProductJobContext {
  knex: Knex
  settings: SettingsStore
  // The uploads bucket (ADR 0020).
  storage: Storage
  logger: Logger
  // Notifications (ADR 0027): `mail.notify(...)` queues one per recipient.
  mail: MailOutbox
}

export type ProductJobHandler = (job: Job, context: ProductJobContext) => Promise<unknown>

export interface ProductSchedule {
  // The job's name, one of the queue's `jobs`; also the scheduler's id.
  job: string
  // A cron pattern with a time zone, as the skeleton's daily jobs (DAILY in
  // jobs/maintenance.ts), or `every` milliseconds.
  repeat: Omit<RepeatOptions, 'key'>
  data?: unknown
  opts?: JobSchedulerTemplateOptions
}

export interface ProductQueue {
  // Unique among all queues, the skeleton's included.
  name: string
  // Jobs of this queue run at most this many at a time per worker process;
  // 1 by default.
  concurrency?: number
  // For what the queue is filled with: retries, backoff, retained history.
  // The skeleton's JOB_OPTIONS by default.
  defaultJobOptions?: JobsOptions
  jobs: Record<string, ProductJobHandler>
  // Created or updated on every worker start; one removed from here is
  // removed from Valkey then as well.
  schedules?: readonly ProductSchedule[]
}

// Every queue, in the order the admin's queue view lists them: the
// skeleton's, then the product's.
export const allQueueNames = (): string[] => [...QUEUE_NAMES, ...PRODUCT_QUEUES.map((queue) => queue.name)]

// Refuses a product queue that shadows another, or a schedule for a job the
// queue does not have.
export const checkProductQueues = (queues: readonly ProductQueue[] = PRODUCT_QUEUES) => {
  const names = [...QUEUE_NAMES, ...queues.map((queue) => queue.name)]
  if (new Set(names).size !== names.length) throw new Error('product queues: a queue name is used twice')
  for (const queue of queues) {
    for (const schedule of queue.schedules ?? []) {
      if (!Object.hasOwn(queue.jobs, schedule.job)) throw new Error(`product queue ${queue.name}: no job ${schedule.job} to schedule`)
    }
  }
}
