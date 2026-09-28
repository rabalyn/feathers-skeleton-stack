import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { AuditEvent } from '../../src/services/audit-events/audit-events.js'
import type { Session } from '../../src/services/sessions/sessions.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'

// ADR 0011's sessions row over HTTP: admins read and revoke every session,
// operators read every session but not the browser of others', and everyone
// reads and revokes their own. Only active sessions are listed.

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
  it('lists a user their own active sessions only, without internal columns', async () => {
    const mine = await login(member)
    const second = await login(member)
    await login(other)
    const listed = await list(mine.token)
    expect(listed.map((session) => session.id).sort()).toEqual([mine.id, second.id].sort())
    expect(listed[0]).toEqual({
      id: expect.any(String),
      userId: member.id,
      issuedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      lastUsedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      idleExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      familyExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      revokedAt: null,
      userAgent: 'browser of us02user'
    })
  })

  it("answers a user's read of someone else's session like a missing one", async () => {
    const mine = await login(member)
    const theirs = await login(other)
    expect((await call(mine.token, `/sessions/${theirs.id}`)).status).toBe(404)
    for (const query of [`?userId=${other.id}`, `?$or[0][userId]=${other.id}`, `?userId[$ne]=${member.id}`]) {
      expect((await list(mine.token, query)).filter((session) => session.userId !== member.id), query).toEqual([])
    }
  })

  it('does not list revoked or expired sessions', async () => {
    const mine = await login(member)
    const revoked = await login(member)
    const expired = await login(member)
    await app.get('sessions').revoke(revoked.id)
    await app.get('knex')('authSessions').where({ id: expired.id }).update({ idleExpiresAt: new Date(Date.now() - 1000) })
    const ids = (await list(mine.token)).map((session) => session.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(revoked.id)
    expect(ids).not.toContain(expired.id)
    expect((await call(mine.token, `/sessions/${revoked.id}`)).status).toBe(404)
  })

  it('lets a user revoke their own session, which ends it and is audited', async () => {
    const mine = await login(member)
    const lost = await login(member)
    const response = await call(mine.token, `/sessions/${lost.id}`, { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: lost.id, userId: member.id, revokedAt: expect.any(String) })

    // The revoked session's token no longer works; the caller's still does.
    expect((await call(lost.token, '/sessions')).status).toBe(401)
    expect((await call(mine.token, '/sessions')).status).toBe(200)
    // Once revoked, it is gone.
    expect((await call(mine.token, `/sessions/${lost.id}`, { method: 'DELETE' })).status).toBe(404)

    const [event] = await app.get('knex')<AuditEvent>('auditEvents').where({ action: 'sessions.revoke', resourceId: lost.id })
    expect(event).toMatchObject({ actorId: member.id, resourceType: 'sessions', detail: { userId: member.id } })
  })

  it("does not let a user revoke someone else's session", async () => {
    const mine = await login(member)
    const theirs = await login(other)
    expect((await call(mine.token, `/sessions/${theirs.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await app.get('sessions').get(theirs.id))?.revokedAt).toBeNull()
  })

  it('shows admins every session, and lets them revoke any', async () => {
    const asAdmin = await login(admin)
    const theirs = await login(other)
    const listed = await list(asAdmin.token, `?userId=${other.id}`)
    expect(listed.find((session) => session.id === theirs.id)).toMatchObject({ userAgent: 'browser of us03othr' })
    expect((await call(asAdmin.token, `/sessions/${theirs.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call(theirs.token, '/sessions')).status).toBe(401)
  })

  it("shows operators every session, but not the browser of others'", async () => {
    const asOperator = await login(operator)
    const theirs = await login(other)

    const listed = await list(asOperator.token)
    const others = listed.find((session) => session.id === theirs.id)
    expect(others).toMatchObject({ id: theirs.id, userId: other.id, lastUsedAt: expect.any(String) })
    expect(others).not.toHaveProperty('userAgent')
    expect(await (await call(asOperator.token, `/sessions/${theirs.id}`)).json()).not.toHaveProperty('userAgent')
    // Their own, they see in full.
    expect(listed.find((session) => session.id === asOperator.id)).toMatchObject({ userAgent: 'browser of op02oper' })
  })

  it("does not let an operator revoke someone else's session, only their own", async () => {
    const asOperator = await login(operator)
    const spare = await login(operator)
    const theirs = await login(other)
    expect((await call(asOperator.token, `/sessions/${theirs.id}`, { method: 'DELETE' })).status).toBe(403)
    expect((await app.get('sessions').get(theirs.id))?.revokedAt).toBeNull()
    expect((await call(asOperator.token, `/sessions/${spare.id}`, { method: 'DELETE' })).status).toBe(200)
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
