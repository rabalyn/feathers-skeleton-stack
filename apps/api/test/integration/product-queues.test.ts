import { randomUUID } from 'node:crypto'
import { Queue, QueueEvents } from 'bullmq'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { queueConnection, startMaintenance, type Maintenance } from '../../src/jobs/maintenance.js'
import { checkProductQueues, type ProductQueue } from '../../src/jobs/product-queues.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'

// ADR 0024, 0035: a product's queue runs beside the skeleton's, with the
// same context, and its schedules kept in step with what it declares.

const QUEUE = 'product-test'

let app: Application
let maintenance: Maintenance
let events: QueueEvents
let connection: ReturnType<typeof queueConnection>
let prefix: string

const definition = (schedules: ProductQueue['schedules']): ProductQueue => ({
  name: QUEUE,
  jobs: {
    // Something only a job with the context can answer.
    count: async (job, { knex }) => {
      const row = await knex('users').count<{ count: string }>('id as count').first()
      return { asked: (job.data as { n?: number }).n, users: Number(row?.count) }
    },
    nightly: async () => 'ran'
  },
  schedules
})

const start = (queue: ProductQueue) =>
  startMaintenance({
    connection,
    knex: app.get('knex'),
    settings: app.get('settings'),
    storage: app.get('storage'),
    exports: app.get('exports'),
    logger: pino({ level: 'silent' }),
    prefix,
    productQueues: [queue]
  })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  connection = queueConnection(await loadValkeyConfig())
  prefix = `test-${randomUUID()}`
  maintenance = start(definition([{ job: 'nightly', repeat: { pattern: '0 2 * * *', tz: 'Europe/Berlin' } }]))
  events = new QueueEvents(QUEUE, { connection, prefix })
  await events.waitUntilReady()
})

afterAll(async () => {
  await events.close()
  for (const queue of [maintenance.queue, maintenance.exportQueue, maintenance.mail.queue, ...maintenance.product.map((each) => each.queue)]) {
    await queue.obliterate({ force: true })
  }
  await maintenance.close()
  await app.teardown()
})

describe('product queues', () => {
  it('runs a job of the product with the skeleton context', async () => {
    const queue = new Queue(QUEUE, { connection, prefix })
    const job = await queue.add('count', { n: 3 })
    expect(await job.waitUntilFinished(events, 10_000)).toEqual({ asked: 3, users: expect.any(Number) })
    await queue.close()
  })

  it('fails a job the queue does not declare, without retrying', async () => {
    const queue = new Queue(QUEUE, { connection, prefix })
    const job = await queue.add('unknown', {}, { attempts: 3 })
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('unknown job unknown')
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1)
    await queue.close()
  })

  it('creates its schedules, and removes one it no longer declares', async () => {
    await maintenance.schedule()
    const [product] = maintenance.product
    expect(await product!.queue.getJobSchedulers()).toEqual([expect.objectContaining({ key: 'nightly', pattern: '0 2 * * *' })])

    // A later start without the schedule.
    const later = start(definition([]))
    await later.schedule()
    expect(await later.product[0]!.queue.getJobSchedulers()).toEqual([])
    await later.close()
  })
})

describe('checkProductQueues', () => {
  it('refuses a queue named like the skeleton’s', () => {
    expect(() => checkProductQueues([{ name: 'mail', jobs: {} }])).toThrow('a queue name is used twice')
  })

  it('refuses a schedule for a job the queue lacks', () => {
    expect(() => checkProductQueues([{ name: QUEUE, jobs: {}, schedules: [{ job: 'missing', repeat: { every: 1000 } }] }])).toThrow(
      'no job missing'
    )
  })
})
