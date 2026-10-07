import { Type, type Static } from '@feathersjs/typebox'
import { queryValidator, lazyValidator } from '../../validators.js'

// The state of one BullMQ queue (ADR 0024), for the admin's queue view:
// counts, the rate limit, the schedules and the jobs that are running or
// due. Job payloads and failure messages are left out: payloads are
// surrogate ids the view has no use for, and an error text can carry an
// address (ADR 0021); both are in the logs and the delivery log.

const nullableTime = Type.Union([Type.String({ format: 'date-time' }), Type.Null()])

export const QUEUE_JOB_STATES = ['active', 'waiting', 'prioritized', 'delayed', 'failed'] as const
export type QueueJobState = (typeof QUEUE_JOB_STATES)[number]

export const queueJobSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    state: Type.Union(QUEUE_JOB_STATES.map((state) => Type.Literal(state))),
    attemptsMade: Type.Integer(),
    attempts: Type.Integer(),
    createdAt: Type.String({ format: 'date-time' }),
    // When a delayed job becomes due: a retry's backoff, or a schedule's
    // next run.
    dueAt: nullableTime,
    processedAt: nullableTime,
    finishedAt: nullableTime,
    // The job scheduler that made it, if any.
    scheduler: Type.Union([Type.String(), Type.Null()])
  },
  { $id: 'QueueJob', additionalProperties: false }
)
export type QueueJob = Static<typeof queueJobSchema>

export const queueSchedulerSchema = Type.Object(
  {
    key: Type.String(),
    name: Type.String(),
    // Cron pattern or interval, as the scheduler was given it.
    pattern: Type.Union([Type.String(), Type.Null()]),
    everyMs: Type.Union([Type.Integer(), Type.Null()]),
    tz: Type.Union([Type.String(), Type.Null()]),
    nextAt: nullableTime
  },
  { $id: 'QueueScheduler', additionalProperties: false }
)
export type QueueScheduler = Static<typeof queueSchedulerSchema>

export const queueStatusSchema = Type.Object(
  {
    // The queue's name.
    id: Type.String(),
    paused: Type.Boolean(),
    counts: Type.Object({
      active: Type.Integer(),
      waiting: Type.Integer(),
      prioritized: Type.Integer(),
      delayed: Type.Integer(),
      failed: Type.Integer(),
      // Only as many as the queue keeps (removeOnComplete).
      completed: Type.Integer()
    }),
    // The queue's global rate limit, and how long until it lets the next
    // job go when it is holding jobs back (0 when it is not).
    rateLimit: Type.Union([
      Type.Object({ max: Type.Integer(), durationMs: Type.Integer(), resetsInMs: Type.Integer() }),
      Type.Null()
    ]),
    schedulers: Type.Array(queueSchedulerSchema),
    // Running first, then waiting in the order they will run, then delayed
    // by due time, then the latest failures; at most QUEUE_JOB_LIMIT per
    // state. The counts give the totals.
    jobs: Type.Array(queueJobSchema),
    updatedAt: Type.String({ format: 'date-time' })
  },
  { $id: 'QueueStatus', additionalProperties: false }
)
export type QueueStatus = Static<typeof queueStatusSchema>

// No parameters: there are only a few queues.
export const queueStatusQuerySchema = Type.Object({}, { $id: 'QueueStatusQuery', additionalProperties: false })
export type QueueStatusQuery = Static<typeof queueStatusQuerySchema>
export const queueStatusQueryValidator = lazyValidator(queueStatusQuerySchema, queryValidator)
