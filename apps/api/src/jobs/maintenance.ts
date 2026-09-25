import { readFileSync } from 'node:fs'
import { Queue, UnrecoverableError, Worker, type JobsOptions, type RedisOptions } from 'bullmq'
import type { Knex } from 'knex'
import type { Logger } from 'pino'
import type { ValkeyConfig } from '../config.js'
import type { SettingsStore } from '../settings/store.js'
import { retentionCleanup } from './retention.js'

// The maintenance queue and its worker (ADR 0024). Recurring jobs are job
// schedulers, so a schedule exists once in Valkey however many workers run.

export const MAINTENANCE_QUEUE = 'maintenance'
// The worker's and the api's Valkey users may reach these keys only
// (ADR 0010).
export const QUEUE_PREFIX = 'bull'

export const RETENTION_CLEANUP = 'retention-cleanup'

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

export interface MaintenanceOptions {
  connection: RedisOptions
  knex: Knex
  settings: SettingsStore
  logger: Logger
  // Tests keep their queues apart.
  prefix?: string
}

export const startMaintenance = ({ connection, knex, settings, logger, prefix = QUEUE_PREFIX }: MaintenanceOptions) => {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix, defaultJobOptions: JOB_OPTIONS })

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      switch (job.name) {
        case RETENTION_CLEANUP:
          return retentionCleanup(knex, settings)
        default:
          throw new UnrecoverableError(`unknown job ${job.name}`)
      }
    },
    { connection, prefix, concurrency: 1 }
  )

  worker.on('completed', (job, result: unknown) => {
    logger.info({ queue: MAINTENANCE_QUEUE, job: job.name, job_id: job.id, result }, 'job completed')
  })
  worker.on('failed', (job, error) => {
    const final = !job || error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1)
    logger[final ? 'error' : 'warn'](
      { queue: MAINTENANCE_QUEUE, job: job?.name, job_id: job?.id, attempt: job?.attemptsMade, err: { message: error.message } },
      final ? 'job failed' : 'job failed, will retry'
    )
  })
  worker.on('error', (error) => logger.error({ err: { message: error.message } }, 'worker error'))

  return {
    queue,
    worker,
    // Creates or updates the schedules; safe to run on every start.
    schedule: () =>
      queue.upsertJobScheduler(RETENTION_CLEANUP, DAILY, { name: RETENTION_CLEANUP, opts: JOB_OPTIONS }),
    isRunning: () => worker.isRunning(),
    close: async () => {
      await worker.close()
      await queue.close()
    }
  }
}

export type Maintenance = ReturnType<typeof startMaintenance>
