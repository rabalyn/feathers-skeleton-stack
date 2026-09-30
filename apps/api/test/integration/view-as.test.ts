import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { grantRoles, makeUser, roleIdOf } from '../support/roles.js'
import { db } from '../support/worker-database.js'

// ADR 0028: read-only view-as, as state of the viewer's session, bounded by
// the viewer's own rights, refused where it must be, and audited.

let app: Application
let base: string
let admin: User
let operator: User
let member: User
let other: User
let breakGlass: User
let memberDocument: string

interface Login {
  sessionId: string
  token: string
}

const login = async (user: User): Promise<Login> => {
  const { session } = await app.get('sessions').issue(user.id)
  const token = await app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id })
  return { sessionId: session.id, token }
}

const call = (who: Login, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/json' } })

const json = async <T>(response: Response) => (await response.json()) as T

const start = (who: Login, userId: string) => call(who, '/view-as', { method: 'POST', body: JSON.stringify({ userId }) })
const stop = (who: Login) => call(who, '/view-as/current', { method: 'DELETE' })

const events = (action: string, resourceId: string) =>
  db()('audit_events').where({ action, resource_id: resourceId }).orderBy('occurred_at')

beforeAll(async () => {
  ;({ app } = await createTestApp())
  base = `http://127.0.0.1:${((await app.listen(0)).address() as AddressInfo).port}/api`
  admin = await makeUser(app, 'ad01admn', 'admin')
  operator = await makeUser(app, 'op01oper', 'operator')
  member = await makeUser(app, 'us01user', 'user')
  other = await makeUser(app, 'us02othr', 'user')
  const local = await app.service('users').create({ tuId: null, givenName: null, surname: null, email: 'bg@example.test', authSource: 'local' })
  breakGlass = await grantRoles(app, local.id, ['admin'])
  // Operators may view as others here; seeded, nobody but admin may.
  const operatorRole = await app.service('roles').get(await roleIdOf(app, 'operator'))
  await app.service('roles').patch(operatorRole.id, { permissions: [...(operatorRole.permissions ?? []), 'users.view-as'] })
  const [file] = await db()('files')
    .insert({ owner_id: member.id, filename: 'a.pdf', content_type: 'application/pdf', size_bytes: 1, sha256: '0'.repeat(64), state: 'stored' })
    .returning<{ id: string }[]>('id')
  const [document] = await db()('documents').insert({ owner_id: member.id, title: 'Mine', file_id: file!.id }).returning<{ id: string }[]>('id')
  memberDocument = document!.id
  await db()('audit_events').insert({ actor_id: member.id, action: 'login', resource_type: 'users', resource_id: member.id })
})

afterAll(async () => {
  await app.teardown()
})

describe('viewing as somebody', () => {
  it("shows the target's application, read-only, and ends on request", async () => {
    const viewer = await login(operator)
    const started = await start(viewer, member.id)
    expect(started.status).toBe(201)
    expect(await json<{ userId: string; expiresAt: string }>(started)).toMatchObject({ userId: member.id, expiresAt: expect.any(String) })

    // The member's own view: their record only, their documents only.
    const users = await json<{ data: User[] }>(await call(viewer, '/users'))
    expect(users.data.map((user) => user.id)).toEqual([member.id])
    const documents = await json<{ data: { id: string }[] }>(await call(viewer, '/documents'))
    expect(documents.data.map((document) => document.id)).toEqual([memberDocument])
    // Their activity, which the operator reads anyway.
    const activity = await json<{ data: { actorId: string }[] }>(await call(viewer, '/audit-events'))
    expect(activity.data.every((event) => event.actorId === member.id)).toBe(true)

    // Nothing is written in their name.
    expect((await call(viewer, `/documents/${memberDocument}`, { method: 'PATCH', body: JSON.stringify({ title: 'Changed' }) })).status).toBe(403)
    expect((await call(viewer, '/locales', { method: 'POST', body: JSON.stringify({ locale: 'en' }) })).status).toBe(403)
    // No chaining.
    expect((await start(viewer, other.id)).status).toBe(403)

    expect((await stop(viewer)).status).toBe(200)
    expect((await json<{ total: number }>(await call(viewer, '/users'))).total).toBeGreaterThan(1)
    expect((await stop(viewer)).status).toBe(404)

    const [begun] = await events('view-as.start', member.id)
    expect(begun).toMatchObject({ actor_id: operator.id, resource_type: 'users', detail: expect.objectContaining({ sessionId: viewer.sessionId }) })
    const [ended] = await events('view-as.end', member.id)
    expect(ended).toMatchObject({ actor_id: operator.id, detail: { sessionId: viewer.sessionId, reason: 'stopped' } })
  })

  it("never shows more than the viewer's own rights: an admin target's settings stay hidden", async () => {
    // Not an admin: that is refused. A user granted settings, though.
    const settingsRole = await app.service('roles').create({ key: 'settings-only', name: { de: 'E', en: 'S' }, permissions: ['settings.manage'] })
    await app.service('user-roles').patch(other.id, { roleIds: [...other.roleIds, settingsRole.id] })
    const viewer = await login(operator)
    expect((await start(viewer, other.id)).status).toBe(201)
    expect((await call(viewer, '/settings')).status).toBe(403)
    await stop(viewer)
    await app.service('user-roles').patch(other.id, { roleIds: other.roleIds })
    await app.service('roles').remove(settingsRole.id)
  })

  it('is refused for oneself, an administrator, the break-glass account, an erased account and without the permission', async () => {
    const viewer = await login(operator)
    expect((await start(viewer, operator.id)).status).toBe(403)
    expect((await start(viewer, admin.id)).status).toBe(403)
    expect((await start(viewer, breakGlass.id)).status).toBe(403)
    const erased = await makeUser(app, 'er01gone', 'user')
    await db()('users').where({ id: erased.id }).update({ erased_at: new Date() })
    expect((await start(viewer, erased.id)).status).toBe(403)
    expect((await start(await login(member), other.id)).status).toBe(403)
    expect(await db()('audit_events').where({ action: 'view-as.start', actor_id: member.id })).toEqual([])
  })

  it('ends when it expires, on the next request, audited', async () => {
    const viewer = await login(operator)
    await start(viewer, member.id)
    await db()('auth_sessions').where({ id: viewer.sessionId }).update({ view_as_expires_at: new Date(Date.now() - 1000) })
    expect((await json<{ total: number }>(await call(viewer, '/users'))).total).toBeGreaterThan(1)
    const ended = await db()('audit_events').where({ action: 'view-as.end' }).whereRaw(`detail->>'sessionId' = ?`, [viewer.sessionId])
    expect(ended).toEqual([expect.objectContaining({ detail: { sessionId: viewer.sessionId, reason: 'expired' } })])
  })

  it('ends with its session, audited', async () => {
    const viewer = await login(operator)
    await start(viewer, member.id)
    await app.get('sessions').revoke(viewer.sessionId)
    const ended = await db()('audit_events').where({ action: 'view-as.end' }).whereRaw(`detail->>'sessionId' = ?`, [viewer.sessionId])
    expect(ended).toEqual([expect.objectContaining({ detail: { sessionId: viewer.sessionId, reason: 'revoked' } })])
  })

  it("moves the caller's connection into the target's channels, and back", async () => {
    const viewer = await login(operator)
    const connection = {}
    const params = {
      provider: 'socketio',
      connection,
      user: operator,
      authenticated: true,
      authentication: { strategy: 'jwt', accessToken: viewer.token, payload: { sid: viewer.sessionId } }
    }
    await app.service('view-as').create({ userId: member.id }, params)
    const members = (name: string) => (app.channels.includes(name) ? app.channel(name).connections : [])
    expect(members(`users/${member.id}`)).toContain(connection)
    expect(members('subjects/users')).not.toContain(connection)
    expect(members('subjects/documents')).not.toContain(connection)

    await app.service('view-as').remove('current', { ...params, viewer: operator, user: member })
    expect(members(`users/${member.id}`)).not.toContain(connection)
    expect(members('subjects/users')).toContain(connection)
  })
})
