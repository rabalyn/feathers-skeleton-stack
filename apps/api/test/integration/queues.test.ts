import type { AddressInfo } from 'node:net'
import { AuthenticationClient } from '@feathersjs/authentication-client'
import socketio from '@feathersjs/socketio-client'
import { Queue, Worker } from 'bullmq'
import { io, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Application } from '../../src/app.js'
import { createClient, SOCKET_PATH, type ClientApplication } from '../../src/client.js'
import { allQueueNames } from '../../src/jobs/product-queues.js'
import { DATA_EXPORTS_QUEUE, MAIL_QUEUE, MAINTENANCE_QUEUE, queueConnection } from '../../src/jobs/queues.js'
import { QUEUE_STATUS_INTERVAL_MS } from '../../src/services/queues/queues.js'
import type { QueueStatus } from '../../src/services/queues/queues.schema.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'
import { PUBLIC_ORIGIN } from '../support/saml-idp.js'
import { grantRoles, type SeededRole } from '../support/roles.js'

// The queue view (ADR 0024): admins read every queue's state, nobody else
// does; a change reaches admin sockets as a `status` event, coalesced, and
// never carries a job's payload or failure message (ADR 0021).

let app: Application
let base: string
let admin: User
let operator: User
let member: User
const queues = new Map<string, Queue>()

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })
const queue = (name: string) => queues.get(name)!

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const connection = queueConnection(await loadValkeyConfig())
  for (const name of allQueueNames()) queues.set(name, new Queue(name, { connection, prefix: app.get('config').queuePrefix }))
  const users = app.service('users')
  const make = async (tuId: string, role: SeededRole) => {
    const created = await users.create({ tuId, givenName: tuId, surname: 'Test', email: null, authSource: 'saml' })
    return grantRoles(app, created.id, [role])
  }
  admin = await make('ad01admn', 'admin')
  operator = await make('op01oper', 'operator')
  member = await make('us01user', 'user')
})

afterAll(async () => {
  for (const each of queues.values()) {
    await each.obliterate({ force: true })
    await each.close()
  }
  await app.teardown()
})

const open: Socket[] = []
afterEach(async () => {
  for (const socket of open.splice(0)) socket.disconnect()
  for (const each of queues.values()) await each.obliterate({ force: true })
})

class ManualAuthenticationClient extends AuthenticationClient {
  override handleSocket(): void {}
}

// An authenticated socket recording the `status` events it receives.
const listenAs = async (user: User) => {
  const socket = io(base, { path: SOCKET_PATH, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { origin: PUBLIC_ORIGIN } })
  open.push(socket)
  const client: ClientApplication = createClient(socketio.default(socket as never), { Authentication: ManualAuthenticationClient })
  const statuses: QueueStatus[] = []
  client.service('queues').on('status', (status: QueueStatus) => statuses.push(status))
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('connect_error', reject))
  const { session } = await app.get('sessions').issue(user.id)
  const accessToken = await app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id })
  await client.authenticate({ strategy: 'jwt', accessToken })
  return statuses
}

describe('reading the queues (ADR 0011)', () => {
  it('is the admin’s alone', async () => {
    const all = await app.service('queues').find(as(admin))
    expect(all.map((each) => each.id)).toEqual(allQueueNames())
    expect((await app.service('queues').get(MAIL_QUEUE, as(admin))).id).toBe(MAIL_QUEUE)
    for (const user of [operator, member]) {
      await expect(app.service('queues').find(as(user)), user.tuId ?? '').rejects.toMatchObject({ code: 403 })
      await expect(app.service('queues').get(MAIL_QUEUE, as(user)), user.tuId ?? '').rejects.toMatchObject({ code: 403 })
    }
  })

  it('knows no other queue', async () => {
    await expect(app.service('queues').get('elsewhere', as(admin))).rejects.toMatchObject({ code: 404 })
  })

  it('refuses query parameters', async () => {
    await expect(app.service('queues').find({ ...as(admin), query: { id: MAIL_QUEUE } })).rejects.toMatchObject({ code: 400 })
  })
})

describe('what a queue’s status shows', () => {
  it('counts, the rate limit, schedules and the jobs that are due, without payloads', async () => {
    const mail = queue(MAIL_QUEUE)
    await mail.setGlobalRateLimit(10, 300_000)
    await mail.add('send-mail', { deliveryId: 'secret-payload' }, { jobId: 'waiting-1', attempts: 5 })
    const before = Date.now()
    await mail.add('send-mail', { deliveryId: 'secret-payload' }, { jobId: 'delayed-1', delay: 60_000 })
    await queue(MAINTENANCE_QUEUE).upsertJobScheduler('retention-cleanup', { pattern: '30 3 * * *', tz: 'Europe/Berlin' }, { name: 'retention-cleanup' })

    const status = await app.service('queues').get(MAIL_QUEUE, as(admin))
    expect(status).toMatchObject({
      id: MAIL_QUEUE,
      paused: false,
      counts: { waiting: 1, delayed: 1, active: 0, failed: 0 },
      rateLimit: { max: 10, durationMs: 300_000, resetsInMs: 0 },
      schedulers: []
    })
    expect(status.jobs).toEqual([
      expect.objectContaining({ id: 'waiting-1', name: 'send-mail', state: 'waiting', attemptsMade: 0, attempts: 5, dueAt: null }),
      expect.objectContaining({ id: 'delayed-1', state: 'delayed', attempts: 1 })
    ])
    const due = Date.parse(status.jobs[1]!.dueAt!)
    expect(due).toBeGreaterThanOrEqual(before + 60_000)
    expect(due).toBeLessThan(Date.now() + 60_000 + 1000)
    expect(JSON.stringify(status)).not.toContain('secret-payload')

    const maintenance = await app.service('queues').get(MAINTENANCE_QUEUE, as(admin))
    expect(maintenance.schedulers).toEqual([
      expect.objectContaining({ key: 'retention-cleanup', name: 'retention-cleanup', pattern: '30 3 * * *', tz: 'Europe/Berlin', everyMs: null })
    ])
    expect(Date.parse(maintenance.schedulers[0]!.nextAt!)).toBeGreaterThan(Date.now())
    // The schedule's next run is a delayed job, tied to its scheduler.
    expect(maintenance.jobs).toEqual([expect.objectContaining({ state: 'delayed', scheduler: 'retention-cleanup' })])
  })

  it('lists failed jobs without their failure message', async () => {
    const exports = queue(DATA_EXPORTS_QUEUE)
    await exports.add('build-export', { exportId: 'x' }, { jobId: 'failing-1', attempts: 1 })
    const worker = new Worker(
      DATA_EXPORTS_QUEUE,
      () => {
        throw new Error('someone@example.test rejected')
      },
      { connection: queueConnection(await loadValkeyConfig()), prefix: app.get('config').queuePrefix }
    )
    try {
      await vi.waitFor(async () => expect(await exports.getFailedCount()).toBe(1), { timeout: 5000, interval: 50 })
    } finally {
      await worker.close()
    }
    const status = await app.service('queues').get(DATA_EXPORTS_QUEUE, as(admin))
    expect(status.counts.failed).toBe(1)
    expect(status.jobs).toEqual([expect.objectContaining({ id: 'failing-1', state: 'failed', attemptsMade: 1, attempts: 1 })])
    expect(status.jobs[0]!.finishedAt).not.toBeNull()
    expect(JSON.stringify(status)).not.toContain('example.test')
  })
})

describe('live status (ADR 0012)', () => {
  it('reaches admins only, coalesced, and ends with the latest state', async () => {
    const [asAdmin, asOperator, asMember] = await Promise.all([listenAs(admin), listenAs(operator), listenAs(member)])
    const mail = queue(MAIL_QUEUE)
    for (let index = 0; index < 5; index++) await mail.add('send-mail', { deliveryId: String(index) }, { jobId: `burst-${index}` })

    await vi.waitFor(() => expect(asAdmin.at(-1)?.counts.waiting).toBe(5), { timeout: 5000, interval: 20 })
    // Five adds, at most an event right away and one after the interval.
    await new Promise((resolve) => setTimeout(resolve, QUEUE_STATUS_INTERVAL_MS + 300))
    expect(asAdmin.length).toBeLessThanOrEqual(2)
    expect(asAdmin.every((status) => status.id === MAIL_QUEUE)).toBe(true)
    expect(asOperator).toEqual([])
    expect(asMember).toEqual([])
  })
})
