import { Queue, UnrecoverableError, Worker, type JobsOptions, type RedisOptions } from 'bullmq'
import type { Knex } from 'knex'
import type { Logger } from 'pino'
import { Counter, Gauge, Histogram, type Registry } from 'prom-client'
import type { SettingsStore } from '../settings/store.js'
import type { Storage } from '../storage.js'
import { buildExport } from '../gdpr/export.js'
import { MailOutbox } from '../mail/outbox.js'
import { BUILD_EXPORT, DATA_EXPORTS_QUEUE, EXPORT_JOB_OPTIONS, QUEUE_PREFIX, type ExportJob } from './queues.js'
import { exportExpiry } from './export-expiry.js'
import { objectPurge } from './object-purge.js'
import { retentionCleanup } from './retention.js'

// The worker's queues and their workers (ADR 0024): `maintenance`, whose
// recurring jobs are job schedulers, so a schedule exists once in Valkey
// however many workers run; and `data-exports`, filled by the api on request
// (ADR 0013).

export const MAINTENANCE_QUEUE = 'maintenance'
export { BUILD_EXPORT, DATA_EXPORTS_QUEUE, QUEUE_PREFIX, queueConnection } from './queues.js'

export const RETENTION_CLEANUP = 'retention-cleanup'
export const OBJECT_PURGE = 'object-purge'
export const EXPORT_EXPIRY = 'export-expiry'
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
}

export const startMaintenance = ({
  connection,
  knex,
  settings,
  storage,
  exports,
  logger,
  prefix = QUEUE_PREFIX,
  metrics
}: MaintenanceOptions) => {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix, defaultJobOptions: JOB_OPTIONS })
  const exportQueue = new Queue<ExportJob>(DATA_EXPORTS_QUEUE, { connection, prefix, defaultJobOptions: EXPORT_JOB_OPTIONS })
  // Notifications the worker causes, and the sweep.
  const mail = new MailOutbox(connection, logger, prefix)
  const queues = [queue, exportQueue] as Queue[]
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

  return {
    queue,
    worker,
    exportQueue,
    exportWorker,
    mail,
    // Creates or updates the schedules; safe to run on every start.
    schedule: async () => {
      for (const name of [RETENTION_CLEANUP, OBJECT_PURGE, EXPORT_EXPIRY]) {
        await queue.upsertJobScheduler(name, DAILY, { name, opts: JOB_OPTIONS })
      }
      await queue.upsertJobScheduler(MAIL_SWEEP, MAIL_SWEEP_EVERY, { name: MAIL_SWEEP, opts: MAIL_SWEEP_OPTIONS })
    },
    isRunning: () => worker.isRunning() && exportWorker.isRunning(),
    close: async () => {
      await Promise.all([worker.close(), exportWorker.close()])
      await Promise.all([queue.close(), exportQueue.close(), mail.close()])
    }
  }
}

export type Maintenance = ReturnType<typeof startMaintenance>
