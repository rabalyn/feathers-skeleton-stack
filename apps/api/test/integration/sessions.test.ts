import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { AuditEvent } from '../../src/services/audit-events/audit-events.js'
import type { Session } from '../../src/services/sessions/sessions.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'

// ADR 0011's sessions row over HTTP: admins read and revoke every session,
// operators read every session but not its browser and revoke none, users
// have no access. Only active sessions are listed.

let app: Application
let base: string
let admin: User
let operator: User
let member: User
let other: User

// A login of `user`, and a bearer token for it, as the refresh would issue.
const login = async (user: User, userAgent = `browser of ${user.tuId}`) => {
  const { session } = await app.get('sessions').issue(user.id, { userAgent })
  const token = await app.service('authentication').createAccessToken({ sid: session.id, role: user.role }, { subject: user.id })
  return { id: session.id, token }
}

const call = (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })

const list = async (token: string, query = '') => {
  const response = await call(token, `/sessions${query}`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: Session[] }).data
}

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const users = app.service('users')
  const make = async (tuId: string, role: User['role']) => {
    const created = await users.create({ tuId, givenName: tuId, surname: 'Test', email: null, authSource: 'saml' })
    return role === 'user' ? created : users.patch(created.id, { role })
  }
  admin = await make('ad02admn', 'admin')
  operator = await make('op02oper', 'operator')
  member = await make('us02user', 'user')
  other = await make('us03othr', 'user')
})

afterAll(async () => {
  await app.teardown()
})

describe('sessions (ADR 0010, 0011)', () => {
  it('shows admins every active session, without internal columns', async () => {
    const asAdmin = await login(admin)
    const theirs = await login(member)
    const listed = await list(asAdmin.token, `?userId=${member.id}`)
    expect(listed.find((session) => session.id === theirs.id)).toEqual({
      id: theirs.id,
      userId: member.id,
      issuedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      lastUsedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      idleExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      familyExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      revokedAt: null,
      userAgent: 'browser of us02user'
    })
    expect(listed.every((session) => session.userId === member.id)).toBe(true)
  })

  it('does not list revoked or expired sessions', async () => {
    const asAdmin = await login(admin)
    const revoked = await login(member)
    const expired = await login(member)
    await app.get('sessions').revoke(revoked.id)
    await app.get('knex')('authSessions').where({ id: expired.id }).update({ idleExpiresAt: new Date(Date.now() - 1000) })
    const ids = (await list(asAdmin.token, `?userId=${member.id}`)).map((session) => session.id)
    expect(ids).not.toContain(revoked.id)
    expect(ids).not.toContain(expired.id)
    expect((await call(asAdmin.token, `/sessions/${revoked.id}`)).status).toBe(404)
  })

  it('lets admins revoke any session, which ends it and is audited', async () => {
    const asAdmin = await login(admin)
    const theirs = await login(member)
    const response = await call(asAdmin.token, `/sessions/${theirs.id}`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: theirs.id, userId: member.id, revokedAt: expect.any(String) })
    expect((await call(theirs.token, '/users')).status).toBe(401)
    // Once revoked, it is gone.
    expect((await call(asAdmin.token, `/sessions/${theirs.id}`, { method: 'DELETE' })).status).toBe(404)

    const [event] = await app.get('knex')<AuditEvent>('auditEvents').where({ action: 'sessions.revoke', resourceId: theirs.id })
    expect(event).toMatchObject({ actorId: admin.id, resourceType: 'sessions', detail: { userId: member.id } })
  })

  it('shows operators every session, but no browser, not even their own', async () => {
    const asOperator = await login(operator)
    const theirs = await login(member)
    const listed = await list(asOperator.token)
    for (const id of [theirs.id, asOperator.id]) {
      const session = listed.find((entry) => entry.id === id)
      expect(session).toMatchObject({ id, lastUsedAt: expect.any(String) })
      expect(session).not.toHaveProperty('userAgent')
    }
    expect(await (await call(asOperator.token, `/sessions/${theirs.id}`)).json()).not.toHaveProperty('userAgent')
  })

  it('does not let an operator revoke any session, not even their own', async () => {
    const asOperator = await login(operator)
    const spare = await login(operator)
    const theirs = await login(member)
    for (const id of [theirs.id, spare.id]) {
      expect((await call(asOperator.token, `/sessions/${id}`, { method: 'DELETE' })).status).toBe(403)
      expect((await app.get('sessions').get(id))?.revokedAt).toBeNull()
    }
  })

  it('gives users no access, not even to their own sessions', async () => {
    const mine = await login(member)
    const spare = await login(member)
    expect((await call(mine.token, '/sessions')).status).toBe(403)
    expect((await call(mine.token, `/sessions/${spare.id}`)).status).toBe(403)
    expect((await call(mine.token, `/sessions/${spare.id}`, { method: 'DELETE' })).status).toBe(403)
    expect((await app.get('sessions').get(spare.id))?.revokedAt).toBeNull()
  })

  it('offers neither creating nor changing sessions, nor revoking many at once', async () => {
    const asAdmin = await login(admin)
    expect((await call(asAdmin.token, '/sessions', { method: 'POST', body: '{}' })).status).toBe(405)
    const theirs = await login(other)
    expect((await call(asAdmin.token, `/sessions/${theirs.id}`, { method: 'PATCH', body: '{}' })).status).toBe(405)
    expect((await call(asAdmin.token, `/sessions?userId=${other.id}`, { method: 'DELETE' })).status).toBe(405)
    expect((await app.get('sessions').get(theirs.id))?.revokedAt).toBeNull()
  })
})
