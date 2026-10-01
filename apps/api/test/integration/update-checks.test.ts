import type { AddressInfo } from 'node:net'
import { AuthenticationClient } from '@feathersjs/authentication-client'
import socketio from '@feathersjs/socketio-client'
import { Queue, Worker } from 'bullmq'
import { io, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Application } from '../../src/app.js'
import { createClient, SOCKET_PATH, type ClientApplication } from '../../src/client.js'
import { MAINTENANCE_QUEUE, UPDATE_CHECK, UPDATE_CHECK_ASKED_ID, queueConnection } from '../../src/jobs/queues.js'
import { SYSTEM_INFO_CHECK_EVENT, type SystemInfoCheckStatus } from '../../src/services/system-info/system-info.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'
import { makeUser } from '../support/roles.js'
import { PUBLIC_ORIGIN } from '../support/saml-idp.js'

// Asking for the update check now (ADR 0032): `system-info.check` queues one
// on the maintenance queue, unless one runs or waits to, or the check is
// off. Whoever reads the system-info page learns from a `check` event when
// a check starts and ends, however it was started.

let app: Application
let base: string
let admin: User
let operator: User
let member: User
let queue: Queue

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })
const ask = (user: User) => app.service('update-checks').create({}, as(user))

beforeAll(async () => {
  ;({ app } = await createTestApp({ system: { updateCheck: 'on' } }))
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  queue = new Queue(MAINTENANCE_QUEUE, { connection: queueConnection(await loadValkeyConfig()), prefix: app.get('config').queuePrefix })
  admin = await makeUser(app, 'ad01admn', 'admin')
  operator = await makeUser(app, 'op01oper', 'operator')
  member = await makeUser(app, 'us01user', 'user')
})

afterAll(async () => {
  await queue.obliterate({ force: true })
  await queue.close()
  await app.teardown()
})

const open: Socket[] = []
afterEach(async () => {
  for (const socket of open.splice(0)) socket.disconnect()
  await queue.obliterate({ force: true })
})

class ManualAuthenticationClient extends AuthenticationClient {
  override handleSocket(): void {}
}

// An authenticated socket recording the `check` events it receives.
const listenAs = async (user: User) => {
  const socket = io(base, { path: SOCKET_PATH, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { origin: PUBLIC_ORIGIN } })
  open.push(socket)
  const client: ClientApplication = createClient(socketio.default(socket as never), { Authentication: ManualAuthenticationClient })
  const statuses: SystemInfoCheckStatus[] = []
  client.service('system-info').on(SYSTEM_INFO_CHECK_EVENT, (status: SystemInfoCheckStatus) => statuses.push(status))
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('connect_error', reject))
  const { session } = await app.get('sessions').issue(user.id)
  const accessToken = await app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id })
  await client.authenticate({ strategy: 'jwt', accessToken })
  return statuses
}

describe('asking for an update check', () => {
  it('queues one for whoever holds system-info.check', async () => {
    await expect(ask(admin)).resolves.toMatchObject({ queuedAt: expect.any(String) })
    const job = await queue.getJob(UPDATE_CHECK_ASKED_ID)
    expect(job).toMatchObject({ name: UPDATE_CHECK, opts: expect.objectContaining({ attempts: 1 }) })
    expect((await app.service('system-info').find(as(admin))).checkRunning).toBe(true)
  })

  it('refuses while a check runs or waits to', async () => {
    await ask(admin)
    await expect(ask(admin)).rejects.toMatchObject({ code: 409 })
  })

  it('refuses while the daily one waits for its retry', async () => {
    await queue.add(UPDATE_CHECK, {}, { jobId: 'daily', attempts: 2, backoff: { type: 'fixed', delay: 60_000 } })
    const failing = new Worker(
      MAINTENANCE_QUEUE,
      async () => {
        throw new Error('no route')
      },
      { connection: queueConnection(await loadValkeyConfig()), prefix: app.get('config').queuePrefix }
    )
    try {
      await vi.waitFor(async () => expect(await queue.getJobState('daily')).toBe('delayed'), { timeout: 10_000 })
    } finally {
      await failing.close()
    }
    await expect(ask(admin)).rejects.toMatchObject({ code: 409 })
  })

  it('does not count the scheduler’s next run, due at night', async () => {
    await queue.upsertJobScheduler(UPDATE_CHECK, { pattern: '30 3 * * *', tz: 'Europe/Berlin' }, { name: UPDATE_CHECK })
    expect((await app.service('system-info').find(as(admin))).checkRunning).toBe(false)
    await expect(ask(admin)).resolves.toBeDefined()
  })

  it('refuses whoever lacks the permission (ADR 0011)', async () => {
    for (const user of [operator, member]) {
      await expect(ask(user), user.tuId ?? '').rejects.toMatchObject({ code: 403 })
    }
    expect(await queue.getJob(UPDATE_CHECK_ASKED_ID)).toBeUndefined()
  })

  it('refuses when the check is off', async () => {
    const { app: off } = await createTestApp({ system: { updateCheck: 'off' } })
    try {
      await expect(off.service('update-checks').create({}, as(admin))).rejects.toMatchObject({ code: 400 })
    } finally {
      await off.teardown()
    }
  })

  it('rejects fields the schema does not declare (ADR 0005)', async () => {
    await expect(app.service('update-checks').create({ now: true }, as(admin))).rejects.toMatchObject({ code: 400 })
  })
})

describe('the check event', () => {
  it('tells whoever reads the page when a check starts and ends', async () => {
    const seen = await listenAs(admin)
    const unseen = await listenAs(member)
    // The api follows the queue once somebody has read the page.
    await app.service('system-info').find(as(admin))
    await ask(admin)
    await vi.waitFor(() => expect(seen).toContainEqual({ running: true }), { timeout: 5000 })

    const worker = new Worker(MAINTENANCE_QUEUE, async () => ({ checked: 0, failed: 0 }), {
      connection: queueConnection(await loadValkeyConfig()),
      prefix: app.get('config').queuePrefix
    })
    try {
      await vi.waitFor(() => expect(seen.at(-1)).toEqual({ running: false }), { timeout: 10_000 })
      // What the page reads on that event says so too.
      expect((await app.service('system-info').find(as(admin))).checkRunning).toBe(false)
    } finally {
      await worker.close()
    }
    expect(unseen).toEqual([])
  })
})
