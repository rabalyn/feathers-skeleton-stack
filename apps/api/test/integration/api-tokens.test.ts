import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PermissionKey } from '../../src/abilities.js'
import type { Application } from '../../src/app.js'
import type { ApiToken } from '../../src/services/api-tokens/api-tokens.schema.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { makeUser, roleIdOf } from '../support/roles.js'
import { db } from '../support/worker-database.js'

// ADR 0029: API tokens, created by whoever holds `api-tokens.create`, used
// over REST with `Authorization: Bearer`, bounded by the owner's rights on
// every request, never beyond the permissions chosen for them, and never
// with the fixed core. The users hold roles of the test's own (ADR 0035).

let app: Application
let base: string
let admin: User
let operator: User
let member: User
let adminLogin: string
let operatorLogin: string
let memberLogin: string
let operatorRoleId: string
// The operator's, but for api-tokens.create, which no seeded role but admin
// holds.
const operatorPermissions: PermissionKey[] = ['users.read', 'documents.all', 'api-tokens.own']

const login = async (user: User): Promise<string> => {
  const { session } = await app.get('sessions').issue(user.id)
  return app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id })
}

const call = (bearer: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' } })

const json = async <T>(response: Response) => (await response.json()) as T

const create = (bearer: string, body: Record<string, unknown>) => call(bearer, '/api-tokens', { method: 'POST', body: JSON.stringify(body) })

const createToken = async (bearer: string, permissions: string[], extra: Record<string, unknown> = {}): Promise<ApiToken> => {
  const response = await create(bearer, { name: 'script', permissions, ...extra })
  expect(response.status).toBe(201)
  return json<ApiToken>(response)
}

const setOperatorPermissions = (permissions: PermissionKey[]) => app.service('roles').patch(operatorRoleId, { permissions })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  base = `http://127.0.0.1:${((await app.listen(0)).address() as AddressInfo).port}/api`
  admin = await makeUser(app, 'tk01admn', 'admin')
  operator = await makeUser(app, 'tk02oper', [...operatorPermissions, 'api-tokens.create'])
  member = await makeUser(app, 'tk03user', ['api-tokens.own'])
  adminLogin = await login(admin)
  operatorLogin = await login(operator)
  memberLogin = await login(member)
  operatorRoleId = await roleIdOf(app, 'tk02oper')
})

afterAll(async () => {
  await app.teardown()
})

describe('creating a token', () => {
  it('answers with the token once and stores only its hash', async () => {
    const created = await createToken(adminLogin, ['users.read'])
    expect(created.token).toMatch(/^apt_[A-Za-z0-9_-]{43}$/)
    expect(created).toMatchObject({ userId: admin.id, name: 'script', permissions: ['users.read'], expiresAt: null, lastUsedAt: null })
    expect(created.hint).toBe(created.token!.slice(-4))
    expect(created).not.toHaveProperty('tokenHash')

    const [row] = await db()('api_tokens').where({ id: created.id })
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(created.token)

    const again = await json<ApiToken>(await call(adminLogin, `/api-tokens/${created.id}`))
    expect(again.token).toBeUndefined()
    expect(again).not.toHaveProperty('tokenHash')

    const [event] = await db()('audit_events').where({ action: 'api-tokens.create', resource_id: created.id })
    expect(event).toMatchObject({ actor_id: admin.id, detail: { name: 'script', permissions: ['users.read'], expiresAt: null } })
  })

  it('is refused without api-tokens.create', async () => {
    expect((await create(memberLogin, { name: 'x', permissions: ['documents.own'] })).status).toBe(403)
  })

  it('refuses unknown and excluded permissions, and permissions the creator does not hold', async () => {
    expect((await create(adminLogin, { name: 'x', permissions: ['nope'] })).status).toBe(400)
    for (const key of ['api-tokens.create', 'api-tokens.manage', 'users.view-as', 'erasures.create', 'settings.manage', 'system-info.check']) {
      expect((await create(adminLogin, { name: 'x', permissions: [key] })).status, key).toBe(400)
    }
    expect((await create(operatorLogin, { name: 'x', permissions: ['queues.read'] })).status).toBe(403)
    expect((await create(adminLogin, { name: 'x', permissions: [] })).status).toBe(400)
  })

  it('refuses an expiry in the past and accepts one in the future', async () => {
    expect((await create(adminLogin, { name: 'x', permissions: ['users.read'], expiresAt: '2000-01-01T00:00:00Z' })).status).toBe(400)
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString()
    expect((await createToken(adminLogin, ['users.read'], { expiresAt })).expiresAt).toBe(expiresAt)
  })
})

describe('using a token', () => {
  it('reads and writes what its permissions grant, and nothing else', async () => {
    const [file] = await db()('files')
      .insert({ owner_id: member.id, filename: 'a.pdf', content_type: 'application/pdf', size_bytes: 1, sha256: '0'.repeat(64), state: 'stored' })
      .returning<{ id: string }[]>('id')
    const [document] = await db()('documents').insert({ owner_id: member.id, title: 'Theirs', file_id: file!.id }).returning<{ id: string }[]>('id')
    const { token } = await createToken(adminLogin, ['users.read', 'documents.all'])

    const users = await json<{ total: number }>(await call(token!, '/users'))
    expect(users.total).toBeGreaterThan(1)
    const patched = await call(token!, `/documents/${document!.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }) })
    expect(patched.status).toBe(200)
    // The admin holds settings, the token does not.
    expect((await call(token!, '/settings')).status).toBe(403)
    expect((await call(token!, '/audit-events')).status).toBe(403)

    const [row] = await db()('api_tokens').where({ user_id: admin.id }).whereNotNull('last_used_at')
    expect(row).toBeDefined()
  })

  it('has no fixed core and no own-data permissions: not even its own tokens or its owner’s activity', async () => {
    const { token } = await createToken(adminLogin, ['documents.all'])
    expect((await call(token!, '/api-tokens')).status).toBe(403)
    expect((await call(token!, '/audit-events')).status).toBe(403)
    expect((await create(token!, { name: 'child', permissions: ['documents.all'] })).status).toBe(403)
  })

  it("never exceeds its owner's current rights", async () => {
    const { token } = await createToken(operatorLogin, ['users.read', 'documents.all'])
    expect((await call(token!, '/users')).status).toBe(200)
    await setOperatorPermissions(['documents.all', 'api-tokens.create'])
    expect((await call(token!, '/users')).status).toBe(403)
    expect((await call(token!, '/documents')).status).toBe(200)
    await setOperatorPermissions([...operatorPermissions, 'api-tokens.create'])
    expect((await call(token!, '/users')).status).toBe(200)
  })

  it('stops working when its owner loses api-tokens.create, is disabled, or it expires', async () => {
    const { token, id } = await createToken(operatorLogin, ['users.read'])
    await setOperatorPermissions(operatorPermissions)
    expect((await call(token!, '/users')).status).toBe(401)
    await setOperatorPermissions([...operatorPermissions, 'api-tokens.create'])
    expect((await call(token!, '/users')).status).toBe(200)

    await app.service('users').patch(operator.id, { enabled: false })
    expect((await call(token!, '/users')).status).toBe(401)
    await app.service('users').patch(operator.id, { enabled: true })
    operatorLogin = await login(operator)
    expect((await call(token!, '/users')).status).toBe(200)

    await db()('api_tokens').where({ id }).update({ expires_at: new Date(Date.now() - 1000) })
    expect((await call(token!, '/users')).status).toBe(401)
  })

  it('is refused when unknown or malformed', async () => {
    expect((await call(`apt_${'A'.repeat(43)}`, '/users')).status).toBe(401)
    expect((await call('apt_short', '/users')).status).toBe(401)
  })

  it('opens no session: the authentication service does not accept it', async () => {
    const { token } = await createToken(adminLogin, ['users.read'])
    const response = await fetch(`${base}/authentication`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'api-token', accessToken: token })
    })
    expect(response.status).toBe(401)
  })
})

describe('seeing and revoking tokens', () => {
  it('lists one’s own; api-tokens.manage lists everybody’s', async () => {
    await createToken(operatorLogin, ['users.read'])
    const own = await json<{ data: ApiToken[] }>(await call(operatorLogin, '/api-tokens?$limit=100'))
    expect(own.data.length).toBeGreaterThan(0)
    expect(own.data.every((token) => token.userId === operator.id)).toBe(true)
    expect(own.data.every((token) => token.token === undefined)).toBe(true)
    const all = await json<{ data: ApiToken[] }>(await call(adminLogin, '/api-tokens?$limit=100'))
    const owners = new Set(all.data.map((token) => token.userId))
    expect(owners.has(admin.id) && owners.has(operator.id)).toBe(true)
  })

  it('revokes at once, one’s own or under api-tokens.manage, and audits it', async () => {
    const mine = await createToken(operatorLogin, ['users.read'])
    expect((await call(memberLogin, `/api-tokens/${mine.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await call(operatorLogin, `/api-tokens/${mine.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call(mine.token!, '/users')).status).toBe(401)
    const [event] = await db()('audit_events').where({ action: 'api-tokens.revoke', resource_id: mine.id })
    expect(event).toMatchObject({ actor_id: operator.id, detail: { userId: operator.id, name: 'script' } })

    const theirs = await createToken(operatorLogin, ['users.read'])
    expect((await call(adminLogin, `/api-tokens/${theirs.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await call(theirs.token!, '/users')).status).toBe(401)
  })
})
