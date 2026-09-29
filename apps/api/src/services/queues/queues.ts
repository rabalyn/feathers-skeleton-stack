import { NotFound, Unavailable } from '@feathersjs/errors'
import type { Params } from '@feathersjs/feathers'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { Queue, QueueEvents, type Job } from 'bullmq'
import type { Application } from '../../app.js'
import { publishTo, subjectChannel } from '../../channels.js'
import { QUEUE_NAMES, queueConnection } from '../../jobs/queues.js'
import {
  queueStatusQueryValidator,
  type QueueJob,
  type QueueJobState,
  type QueueStatus,
  type QueueStatusQuery
} from './queues.schema.js'

// The queue view (ADR 0024), under `queues.read` (ADR 0011): what the worker
// is doing and what it will do. Read-only; the retries and the outbox sweep
// recover work by themselves. The api listens to every queue's events and,
// while somebody who reads it is connected, publishes the changed queue's status as a
// `status` event to its subject channel (ADR 0012), at most once a second per
// queue, however busy the queue is.

export const QUEUES_PATH = 'queues'
export const QUEUE_EXTERNAL_METHODS = ['find', 'get'] as const
export const QUEUE_STATUS_EVENT = 'status'

// Jobs listed per state; the counts give the totals.
export const QUEUE_JOB_LIMIT = 50
// The least time between two status events of one queue.
export const QUEUE_STATUS_INTERVAL_MS = 1000

// The events that change what the view shows.
const CHANGES = [
  'added',
  'waiting',
  'active',
  'progress',
  'completed',
  'failed',
  'delayed',
  'removed',
  'stalled',
  'paused',
  'resumed',
  'cleaned',
  'drained'
] as const

// Delayed jobs sit in a sorted set whose score is the due time times 0x1000
// plus a counter (BullMQ's getDelayedScore).
const DELAYED_SCORE_FACTOR = 0x1000

const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : null)

export type QueueParams = Params<QueueStatusQuery>

export class QueueService {
  private readonly queues = new Map<string, Queue>()
  private readonly events: QueueEvents[] = []
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private readonly lastSent = new Map<string, number>()
  private closed = false

  constructor(private readonly app: Application) {}

  // The connections are opened by the first read, which is somebody opening
  // the page: an api nobody watches the queues of holds none of them.
  private open() {
    if (this.queues.size || this.closed) return
    const config = this.app.get('config')
    const connection = queueConnection(config)
    for (const name of QUEUE_NAMES) {
      this.queues.set(name, new Queue(name, { connection, prefix: config.queuePrefix }))
      const events = new QueueEvents(name, { connection, prefix: config.queuePrefix })
      for (const change of CHANGES) events.on(change, () => this.changed(name))
      events.on('error', (error: Error) =>
        this.app.get('logger').warn({ queue: name, err: { message: error.message } }, 'queue events unavailable')
      )
      this.events.push(events)
    }
  }

  async teardown() {
    this.closed = true
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    await Promise.all([...this.events.map((events) => events.close()), ...[...this.queues.values()].map((queue) => queue.close())])
  }

  async find(_params?: QueueParams): Promise<QueueStatus[]> {
    return Promise.all(QUEUE_NAMES.map((name) => this.status(name)))
  }

  async get(name: string, _params?: QueueParams): Promise<QueueStatus> {
    if (!(QUEUE_NAMES as readonly string[]).includes(name)) throw new NotFound(`No record found for id '${name}'`)
    return this.status(name)
  }

  async status(name: string): Promise<QueueStatus> {
    this.open()
    const queue = this.queues.get(name)
    if (!queue) throw new Unavailable('The queues are shut down')
    const [paused, counts, rateLimit, resetsInMs, schedulers, active, waiting, prioritized, delayed, failed] = await Promise.all([
      queue.isPaused(),
      queue.getJobCounts('active', 'waiting', 'prioritized', 'delayed', 'failed', 'completed'),
      queue.getGlobalRateLimit(),
      queue.getRateLimitTtl(),
      queue.getJobSchedulers(0, -1, true),
      queue.getActive(0, QUEUE_JOB_LIMIT - 1),
      queue.getWaiting(0, QUEUE_JOB_LIMIT - 1),
      queue.getPrioritized(0, QUEUE_JOB_LIMIT - 1),
      queue.getDelayed(0, QUEUE_JOB_LIMIT - 1),
      queue.getFailed(0, QUEUE_JOB_LIMIT - 1)
    ])
    const dueAt = await this.dueTimes(queue, delayed)
    const listed = (state: QueueJobState, jobs: (Job | undefined)[]): QueueJob[] =>
      // A job removed between listing and reading comes back undefined.
      jobs.filter((job): job is Job => !!job?.id).map((job) => ({
        id: job.id!,
        name: job.name,
        state,
        attemptsMade: job.attemptsMade,
        // Unset, BullMQ reports 0; every job runs at least once.
        attempts: Math.max(job.opts.attempts ?? 1, 1),
        createdAt: new Date(job.timestamp).toISOString(),
        dueAt: state === 'delayed' ? iso(dueAt.get(job.id!)) : null,
        processedAt: iso(job.processedOn),
        finishedAt: iso(job.finishedOn),
        scheduler: job.repeatJobKey ?? null
      }))
    return {
      id: name,
      paused,
      counts: {
        active: counts.active ?? 0,
        waiting: counts.waiting ?? 0,
        prioritized: counts.prioritized ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0
      },
      rateLimit: rateLimit ? { max: rateLimit.max, durationMs: rateLimit.duration, resetsInMs: Math.max(resetsInMs, 0) } : null,
      schedulers: schedulers.map((scheduler) => ({
        key: scheduler.key,
        name: scheduler.name,
        pattern: scheduler.pattern ?? null,
        everyMs: scheduler.every ?? null,
        tz: scheduler.tz ?? null,
        nextAt: iso(scheduler.next)
      })),
      jobs: [
        ...listed('active', active),
        ...listed('waiting', waiting),
        ...listed('prioritized', prioritized),
        ...listed('delayed', delayed),
        ...listed('failed', failed)
      ],
      updatedAt: new Date().toISOString()
    }
  }

  // A retry's backoff counts from its failure, not from the job's creation,
  // so the due time is read from the delayed set itself.
  private async dueTimes(queue: Queue, jobs: (Job | undefined)[]) {
    const ids = jobs.map((job) => job?.id).filter((id): id is string => !!id)
    const due = new Map<string, number>()
    if (!ids.length) return due
    const client = await queue.getBackend().client
    const key = queue.toKey('delayed')
    const scores = await Promise.all(ids.map((id) => client.zscore(key, id)))
    ids.forEach((id, index) => {
      const score = scores[index]
      if (score !== null && score !== undefined) due.set(id, Math.floor(Number(score) / DELAYED_SCORE_FACTOR))
    })
    return due
  }

  // Coalesces a queue's changes into one status event per interval, sent
  // only while somebody is there to receive it.
  private changed(name: string) {
    if (this.closed || this.pending.has(name) || !this.anyReader()) return
    const wait = Math.max(0, (this.lastSent.get(name) ?? 0) + QUEUE_STATUS_INTERVAL_MS - Date.now())
    this.pending.set(
      name,
      setTimeout(() => {
        // A change while the status is read schedules the next event, so
        // the last one sent is never older than the last change.
        this.pending.delete(name)
        this.lastSent.set(name, Date.now())
        this.send(name).catch((error: Error) =>
          this.app.get('logger').warn({ queue: name, err: { message: error.message } }, 'queue status not published')
        )
      }, wait)
    )
  }

  private anyReader() {
    const channel = subjectChannel(QUEUES_PATH)
    return this.app.channels.includes(channel) && this.app.channel(channel).length > 0
  }

  private async send(name: string) {
    if (this.closed) return
    const status = await this.status(name)
    if (this.closed) return
    // A custom event carries no hook context; this one gives the publisher
    // what it needs: the path for the ability check and the payload.
    const service = this.app.service(QUEUES_PATH)
    const context = { app: this.app, path: QUEUES_PATH, service, event: QUEUE_STATUS_EVENT, result: status, dispatch: status }
    service.emit(QUEUE_STATUS_EVENT, status, context)
  }
}

export const queues = (app: Application) => {
  app.use(QUEUES_PATH, new QueueService(app), { methods: [...QUEUE_EXTERNAL_METHODS], events: [QUEUE_STATUS_EVENT] })
  app.service(QUEUES_PATH).hooks({
    before: { all: [schemaHooks.validateQuery(queueStatusQueryValidator)] }
  })
  // Runtime state, for whoever reads the queues (ADR 0012).
  app.service(QUEUES_PATH).publish(QUEUE_STATUS_EVENT, publishTo(app, () => [subjectChannel(QUEUES_PATH)]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [QUEUES_PATH]: QueueService
  }
}
