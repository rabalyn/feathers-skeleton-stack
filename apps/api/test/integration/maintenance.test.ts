import { randomUUID } from 'node:crypto'
import { QueueEvents } from 'bullmq'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Application } from '../../src/app.js'
import {
  DAILY,
  OBJECT_PURGE,
  RETENTION_CLEANUP,
  queueConnection,
  startMaintenance,
  type Maintenance
} from '../../src/jobs/maintenance.js'
import { createRegistry } from '../../src/metrics.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'

// ADR 0024 against the stack's Valkey: the schedule exists once, and a job
// is processed by the worker. Queues live under a prefix of this file's own.

let app: Application
let maintenance: Maintenance
// Completion is observed through the queue's events.
let events: QueueEvents
const metrics = createRegistry('worker')

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const connection = queueConnection(await loadValkeyConfig())
  const prefix = `test-${randomUUID()}`
  maintenance = startMaintenance({
    connection,
    knex: app.get('knex'),
    settings: app.get('settings'),
    storage: app.get('storage'),
    logger: pino({ level: 'silent' }),
    prefix,
    metrics
  })
  events = new QueueEvents(maintenance.queue.name, { connection, prefix })
  await events.waitUntilReady()
})

afterAll(async () => {
  await events.close()
  await maintenance.queue.obliterate({ force: true })
  await maintenance.close()
  await app.teardown()
})

describe('maintenance queue', () => {
  it('schedules retention cleanup and the object purge daily at 03:30 Berlin time, once however often it starts', async () => {
    await maintenance.schedule()
    await maintenance.schedule()
    const schedulers = await maintenance.queue.getJobSchedulers()
    expect(schedulers).toHaveLength(2)
    for (const key of [RETENTION_CLEANUP, OBJECT_PURGE]) {
      expect(schedulers).toContainEqual(expect.objectContaining({ key, pattern: DAILY.pattern, tz: DAILY.tz }))
    }
  })

  it('runs retention cleanup when the job arrives', async () => {
    const job = await maintenance.queue.add(RETENTION_CLEANUP, {})
    const result = await job.waitUntilFinished(events, 10_000)
    expect(result).toEqual({ auditEvents: expect.any(Number), sessions: expect.any(Number) })
  })

  it('runs the object purge when the job arrives', async () => {
    const job = await maintenance.queue.add(OBJECT_PURGE, {})
    const result = await job.waitUntilFinished(events, 10_000)
    expect(result).toEqual({
      purged: expect.any(Number),
      abandoned: expect.any(Number),
      unfinished: expect.any(Number),
      orphans: expect.any(Number)
    })
  })

  it('reports job outcomes, durations and queue depth (ADR 0022)', async () => {
    // The worker's own completion event may trail the queue's.
    await vi.waitFor(async () =>
      expect(await metrics.metrics()).toMatch(/bullmq_jobs_total\{queue="maintenance",outcome="completed",service="worker"\} [1-9]/)
    )
    const text = await metrics.metrics()
    expect(text).toMatch(/bullmq_job_duration_seconds_count\{service="worker",queue="maintenance"\} [1-9]/)
    expect(text).toMatch(/bullmq_queue_jobs\{queue="maintenance",state="waiting",service="worker"\} \d+/)
  })

  it('fails an unknown job at once, without retrying', async () => {
    const job = await maintenance.queue.add('no-such-job', {})
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/unknown job no-such-job/)
    const failed = await maintenance.queue.getJob(job.id ?? '')
    expect(failed?.attemptsMade).toBe(1)
  })
})
