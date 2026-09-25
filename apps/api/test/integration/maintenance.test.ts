import { randomUUID } from 'node:crypto'
import { QueueEvents } from 'bullmq'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import {
  DAILY,
  RETENTION_CLEANUP,
  queueConnection,
  startMaintenance,
  type Maintenance
} from '../../src/jobs/maintenance.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'

// ADR 0024 against the stack's Valkey: the schedule exists once, and a job
// is processed by the worker. Queues live under a prefix of this file's own.

let app: Application
let maintenance: Maintenance
// Completion is observed through the queue's events.
let events: QueueEvents

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const connection = queueConnection(await loadValkeyConfig())
  const prefix = `test-${randomUUID()}`
  maintenance = startMaintenance({
    connection,
    knex: app.get('knex'),
    settings: app.get('settings'),
    logger: pino({ level: 'silent' }),
    prefix
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
  it('schedules retention cleanup daily at 03:30 Berlin time, once however often it starts', async () => {
    await maintenance.schedule()
    await maintenance.schedule()
    const schedulers = await maintenance.queue.getJobSchedulers()
    expect(schedulers).toHaveLength(1)
    expect(schedulers[0]).toMatchObject({ key: RETENTION_CLEANUP, pattern: DAILY.pattern, tz: DAILY.tz })
  })

  it('runs retention cleanup when the job arrives', async () => {
    const job = await maintenance.queue.add(RETENTION_CLEANUP, {})
    const result = await job.waitUntilFinished(events, 10_000)
    expect(result).toEqual({ auditEvents: expect.any(Number), sessions: expect.any(Number) })
  })

  it('fails an unknown job at once, without retrying', async () => {
    const job = await maintenance.queue.add('no-such-job', {})
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/unknown job no-such-job/)
    const failed = await maintenance.queue.getJob(job.id ?? '')
    expect(failed?.attemptsMade).toBe(1)
  })
})
