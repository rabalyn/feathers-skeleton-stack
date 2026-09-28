import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { AuditEvent } from '../../src/services/audit-events/audit-events.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'

// ADR 0011's audit event row over HTTP: admins and operators read all,
// a user their own; nobody writes through the service.

let app: Application
let base: string
let admin: User
let operator: User
let member: User

const get = async (user: User, path: string, init: RequestInit = {}) => {
  const { session } = await app.get('sessions').issue(user.id)
  const token = await app.service('authentication').createAccessToken({ sid: session.id, role: user.role }, { subject: user.id })
  return fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
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
  admin = await make('ad01admn', 'admin')
  operator = await make('op01oper', 'operator')
  member = await make('us01user', 'user')
  const knex = app.get('knex')
  await knex('auditEvents').insert([
    { actorId: member.id, action: 'login', resourceType: 'users', resourceId: member.id, occurredAt: new Date(Date.now() - 2000) },
    { actorId: admin.id, action: 'users.patch', resourceType: 'users', resourceId: member.id, detail: JSON.stringify({ role: 'user' }) },
    { actorId: null, action: 'breakglass.create', resourceType: 'users' }
  ])
})

afterAll(async () => {
  await app.teardown()
})

const actions = async (response: Response) => ((await response.json()) as { data: AuditEvent[] }).data.map((event) => event.action)

describe('audit events (ADR 0011, 0013)', () => {
  it('shows all events to admins and operators, newest first', async () => {
    for (const user of [admin, operator]) {
      const response = await get(user, '/audit-events')
      expect(response.status, user.role).toBe(200)
      const listed = await actions(response)
      expect(listed).toEqual(expect.arrayContaining(['login', 'users.patch', 'breakglass.create']))
      expect(listed.indexOf('users.patch')).toBeLessThan(listed.indexOf('login'))
    }
  })

  it('shows a user only what they did', async () => {
    expect(await actions(await get(member, '/audit-events'))).toEqual(['login'])
    const theirs = (await (await get(admin, '/audit-events?action=users.patch')).json()) as { data: AuditEvent[] }
    expect((await get(member, `/audit-events/${theirs.data[0]!.id}`)).status).toBe(404)
  })

  it("cannot be widened to others' events by the query", async () => {
    for (const query of [`$or[0][actorId]=${admin.id}`, `actorId[$ne]=${member.id}`, `$or[0][resourceId]=${member.id}`]) {
      // 'login' is the member's only event; the others are the admin's and the system's.
      expect((await actions(await get(member, `/audit-events?${query}`))).filter((action) => action !== 'login'), query).toEqual([])
    }
  })

  it('filters, and returns the event as recorded', async () => {
    const response = await get(admin, `/audit-events?resourceId=${member.id}&action=users.patch`)
    const { data } = (await response.json()) as { data: AuditEvent[] }
    expect(data).toEqual([
      expect.objectContaining({ actorId: admin.id, action: 'users.patch', resourceType: 'users', detail: { role: 'user' } })
    ])
    expect(data[0]!.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('cannot be written', async () => {
    const response = await get(admin, '/audit-events', { method: 'POST', body: JSON.stringify({ action: 'forged' }) })
    expect(response.status).toBe(405)
  })
})
