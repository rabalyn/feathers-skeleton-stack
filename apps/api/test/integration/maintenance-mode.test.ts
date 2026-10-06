import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { inflateRawSync } from 'node:zlib'
import { pino } from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import { queueConnection, startMaintenance, type Maintenance } from '../../src/jobs/maintenance.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp, loadValkeyConfig } from '../support/app.js'
import { allBut, makeUser } from '../support/roles.js'
import { PUBLIC_ORIGIN, type TestIdp } from '../support/saml-idp.js'
import { db } from '../support/worker-database.js'

// ADR 0025, maintenance mode: while it is on, only holders of
// `settings.manage` use the application; everyone else and every API token
// is answered 503 with `data.maintenance`, switching it on ends their
// sessions, the ACS sends them to the maintenance page, and the worker takes
// no job.

let app: Application
let idp: TestIdp
let base: string
let admin: User
let member: User

const setMaintenance = (value: boolean) => app.service('settings').patch('maintenanceMode', { value }, { user: admin })

const accessToken = async (user: User): Promise<{ token: string; sessionId: string }> => {
  const { session } = await app.get('sessions').issue(user.id)
  return { token: await app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id }), sessionId: session.id }
}

const cookieFor = async (user: User): Promise<{ cookie: string; sessionId: string }> => {
  const { session, refreshToken } = await app.get('sessions').issue(user.id)
  return { cookie: `refresh_token=${refreshToken}`, sessionId: session.id }
}

const call = (bearer: string, path: string) => fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${bearer}` } })

const refresh = (cookie?: string) =>
  fetch(`${base}/api/authentication`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ strategy: 'refresh' })
  })

const samlLogin = async (tuId: string) => {
  const location = await fetch(`${base}/api/auth/saml/login?returnTo=/start`, { redirect: 'manual' }).then((r) => r.headers.get('location') ?? '')
  const request = inflateRawSync(Buffer.from(new URL(location).searchParams.get('SAMLRequest') ?? '', 'base64')).toString()
  const inResponseTo = /ID="([^"]+)"/.exec(request)?.[1] ?? ''
  const SAMLResponse = await idp.response({
    inResponseTo,
    attributes: { cn: tuId, givenName: tuId, sn: 'Test', mail: `${tuId}@example.org` }
  })
  return fetch(`${base}/api/auth/saml/acs`, { method: 'POST', body: new URLSearchParams({ SAMLResponse }), redirect: 'manual' })
}

const isMaintenanceAnswer = async (response: Response) => {
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 503, data: { maintenance: true } })
}

const revokedAt = async (sessionId: string) => (await db()('auth_sessions').where({ id: sessionId }).first('revoked_at')).revoked_at

beforeAll(async () => {
  ;({ app, idp } = await createTestApp())
  base = `http://127.0.0.1:${((await app.listen(0)).address() as AddressInfo).port}`
  admin = await makeUser(app, 'mm01admn', 'admin')
  // Everything but the bypass, through a role of the test's own (ADR 0035).
  member = await makeUser(app, 'mm02user', allBut('settings.manage'))
})

afterEach(async () => {
  await setMaintenance(false)
})

afterAll(async () => {
  await app.teardown()
})

describe('the public state', () => {
  it('says whether maintenance mode is on, to anyone, uncached', async () => {
    const off = await fetch(`${base}/api/maintenance`)
    expect(off.status).toBe(200)
    expect(off.headers.get('cache-control')).toBe('no-store')
    expect(await off.json()).toEqual({ active: false })
    await setMaintenance(true)
    expect(await (await fetch(`${base}/api/maintenance`)).json()).toEqual({ active: true })
  })
})

describe('switching it on', () => {
  it('ends the sessions of everyone who may not bypass it, and only those', async () => {
    const theirs = await accessToken(member)
    const ours = await accessToken(admin)
    await setMaintenance(true)
    expect(await revokedAt(theirs.sessionId)).not.toBeNull()
    expect(await revokedAt(ours.sessionId)).toBeNull()

    const [event] = await db()('audit_events').where({ action: 'maintenance.enable' }).orderBy('occurred_at', 'desc')
    expect(event).toMatchObject({ actor_id: admin.id, resource_id: 'maintenanceMode' })
    expect(event.detail.revokedSessions).toBeGreaterThanOrEqual(1)
  })

  it('is audited when switched off again, and ends nothing then', async () => {
    await setMaintenance(true)
    const later = await accessToken(admin)
    await setMaintenance(false)
    expect(await revokedAt(later.sessionId)).toBeNull()
    const [event] = await db()('audit_events').where({ action: 'maintenance.disable' }).orderBy('occurred_at', 'desc')
    expect(event).toMatchObject({ actor_id: admin.id, resource_id: 'maintenanceMode' })
  })

  it('does nothing when it was already on', async () => {
    await setMaintenance(true)
    const before = await db()('audit_events').where({ action: 'maintenance.enable' }).count<{ count: string }[]>('* as count')
    await setMaintenance(true)
    const after = await db()('audit_events').where({ action: 'maintenance.enable' }).count<{ count: string }[]>('* as count')
    expect(after[0]!.count).toBe(before[0]!.count)
  })
})

describe('while it is on', () => {
  it('answers everyone but holders of settings.manage with 503', async () => {
    await setMaintenance(true)
    // A session the switch did not see, as if it had been opened meanwhile.
    const theirs = await accessToken(member)
    const ours = await accessToken(admin)
    await isMaintenanceAnswer(await call(theirs.token, `/users/${member.id}`))
    expect((await call(ours.token, `/users/${member.id}`)).status).toBe(200)
    await setMaintenance(false)
    expect((await call(theirs.token, `/users/${member.id}`)).status).toBe(200)
  })

  it('refuses every API token, an admin’s included', async () => {
    const ours = await accessToken(admin)
    const created = await fetch(`${base}/api/api-tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ours.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'script', permissions: ['users.read'] })
    })
    const { token } = (await created.json()) as { token: string }
    expect((await call(token, '/users')).status).toBe(200)
    await setMaintenance(true)
    await isMaintenanceAnswer(await call(token, '/users'))
  })

  it('refuses a refresh, with or without a session, but an admin’s', async () => {
    const theirs = await cookieFor(member)
    const ours = await cookieFor(admin)
    await setMaintenance(true)
    await isMaintenanceAnswer(await refresh(theirs.cookie))
    await isMaintenanceAnswer(await refresh())
    expect((await refresh(ours.cookie)).status).toBe(201)
  })

  it('undoes a refresh that succeeded for somebody who may not bypass it, and refuses their socket', async () => {
    await setMaintenance(true)
    const fresh = await cookieFor(member)
    await isMaintenanceAnswer(await refresh(fresh.cookie))
    expect(await revokedAt(fresh.sessionId)).not.toBeNull()

    const jwt = await accessToken(member)
    const response = await fetch(`${base}/api/authentication`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'jwt', accessToken: jwt.token })
    })
    // Refused while the strategy loads the user, before any session is
    // established; every later call of that session is refused the same way.
    await isMaintenanceAnswer(response)
  })

  it('sends a login at the ACS to the maintenance page, but an admin’s', async () => {
    await setMaintenance(true)
    const refused = await samlLogin('mm02user')
    expect(refused.status).toBe(303)
    expect(refused.headers.get('location')).toBe('/maintenance')
    expect(refused.headers.get('set-cookie')).toBeNull()
    const [event] = await db()('audit_events').where({ action: 'login.refused', actor_id: member.id }).orderBy('occurred_at', 'desc')
    expect(event.detail).toEqual({ reason: 'maintenance' })

    const admitted = await samlLogin('mm01admn')
    expect(admitted.status).toBe(303)
    expect(admitted.headers.get('location')).toBe('/start')
    expect(admitted.headers.get('set-cookie')).toMatch(/^refresh_token=/)
  })
})

describe('the worker', () => {
  let maintenance: Maintenance

  beforeAll(async () => {
    maintenance = startMaintenance({
      connection: queueConnection(await loadValkeyConfig()),
      knex: app.get('knex'),
      settings: app.get('settings'),
      storage: app.get('storage'),
      exports: app.get('exports'),
      logger: pino({ level: 'silent' }),
      prefix: `test-${randomUUID()}`
    })
  })

  afterAll(async () => {
    await maintenance.queue.obliterate({ force: true })
    await maintenance.exportQueue.obliterate({ force: true })
    await maintenance.mail.queue.obliterate({ force: true })
    await maintenance.close()
  })

  it('takes no job while it is on, stays live, and resumes when it is off', async () => {
    await maintenance.applyMaintenanceMode()
    expect(maintenance.isPaused()).toBe(false)

    await setMaintenance(true)
    await maintenance.applyMaintenanceMode()
    expect(maintenance.isPaused()).toBe(true)
    expect(maintenance.worker.isPaused()).toBe(true)
    expect(maintenance.exportWorker.isPaused()).toBe(true)
    expect(maintenance.isRunning()).toBe(true)
    const job = await maintenance.queue.add('retention-cleanup', {})
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(await job.getState()).toBe('waiting')

    await setMaintenance(false)
    await maintenance.applyMaintenanceMode()
    expect(maintenance.isPaused()).toBe(false)
    expect(maintenance.worker.isPaused()).toBe(false)
    await expect.poll(() => job.getState(), { timeout: 10_000 }).toBe('completed')
  })
})
