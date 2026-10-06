import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User, UserQuery } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { makeUser, roleIdOf } from '../support/roles.js'

// The `users` rules of ADR 0011, each tested with and without the permission
// that grants it, including the denied cells (ADR 0018). The users hold roles
// of the test's own (ADR 0035): `operator` reads every user, `member` and
// `other` hold nothing beyond the fixed core and their own locale.

let app: Application
let admin: User
let operator: User
let member: User
let other: User

// An already authenticated external call; authentication itself is tested in
// authentication.test.ts.
const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  admin = await makeUser(app, 'ad01admn', 'admin')
  operator = await makeUser(app, 'op01oper', ['users.read', 'profile.locale'])
  member = await makeUser(app, 'us01user', ['profile.locale'])
  other = await makeUser(app, 'us02othr', ['profile.locale'])
})

afterAll(async () => {
  await app.teardown()
})

describe('users: boundary', () => {
  it('rejects unauthenticated external calls', async () => {
    await expect(app.service('users').find({ provider: 'rest' })).rejects.toMatchObject({ code: 401 })
  })

  it('does not expose create or remove over the transports', async () => {
    // app.teardown() in afterAll closes the server.
    const server = await app.listen(0)
    const { port } = server.address() as { port: number }
    const base = `http://127.0.0.1:${port}/api/users`
    const post = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tuId: 'x', authSource: 'saml' })
    })
    expect(post.status).toBe(405)
    expect((await fetch(`${base}/${other.id}`, { method: 'DELETE' })).status).toBe(405)
  })

  it('refuses create even to a direct external-style call', async () => {
    await expect(
      app.service('users').create(
        { tuId: 'x', givenName: null, surname: null, email: null, authSource: 'saml' },
        as(admin)
      )
    ).rejects.toMatchObject({ code: 403 })
  })

  it('returns camelCase fields and the UUID as the resource address', async () => {
    const user = await app.service('users').get(member.id, as(member))
    expect(user).toMatchObject({ id: member.id, tuId: 'us01user', givenName: 'us01user', authSource: 'saml' })
    expect(Object.keys(user).some((k) => k.includes('_'))).toBe(false)
  })

  it('paginates by default and caps the page size', async () => {
    const page = await app.service('users').find({ ...as(admin), query: { $limit: 1000 } })
    expect(page).toMatchObject({ limit: 100, total: 4 })
    const byDefault = await app.service('users').find(as(admin))
    expect(byDefault).toMatchObject({ limit: 25 })
  })

  it('rejects unknown query fields', async () => {
    await expect(
      app.service('users').find({ ...as(admin), query: { nope: 1 } as never })
    ).rejects.toMatchObject({ code: 400 })
  })
})

describe('users: own user record — read for every account', () => {
  it.each([
    ['admin', () => admin],
    ['operator', () => operator],
    ['user', () => member]
  ])('%s reads their own record', async (_role, who) => {
    const self = who()
    await expect(app.service('users').get(self.id, as(self))).resolves.toMatchObject({ id: self.id })
  })
})

describe('users: all user records — read under users.read', () => {
  it.each([
    ['admin', () => admin],
    ['operator', () => operator]
  ])('%s lists and reads every user', async (_role, who) => {
    const page = await app.service('users').find(as(who()))
    expect(page.total).toBe(4)
    await expect(app.service('users').get(other.id, as(who()))).resolves.toMatchObject({ id: other.id })
  })

  it('user sees only themselves in a list', async () => {
    const page = await app.service('users').find(as(member))
    expect(page.data.map((u) => u.id)).toEqual([member.id])
  })

  it('user cannot find another user by querying for them', async () => {
    const page = await app.service('users').find({ ...as(member), query: { tuId: 'us02othr' } })
    expect(page.total).toBe(0)
  })

  it('user cannot widen their scope with $or or $ne', async () => {
    const queries: UserQuery[] = [{ $or: [{ id: other.id }, { id: member.id }] }, { id: { $ne: member.id } }, { $or: [{ tuId: 'us02othr' }] }, { roleId: operator.roleIds[0] }]
    for (const query of queries) {
      const page = await app.service('users').find({ ...as(member), query })
      expect(page.data.every((u) => u.id === member.id), JSON.stringify(query)).toBe(true)
    }
  })

  it('user reading another user gets 404, exactly like a missing record', async () => {
    const existing = await app.service('users').get(other.id, as(member)).catch((e) => e)
    const missing = await app.service('users').get(randomUUID(), as(member)).catch((e) => e)
    expect(existing).toMatchObject({ code: 404 })
    expect(missing).toMatchObject({ code: 404 })
    expect(existing.message).toBe(missing.message.replace(/[0-9a-f-]{36}/, other.id))
  })
})

describe('users: roles on the record (ADR 0011)', () => {
  it('carries the ids of the roles held, and the permissions to the holder only', async () => {
    const own = await app.service('users').get(operator.id, as(operator))
    expect(own.roleIds).toEqual([await roleIdOf(app, 'op01oper')])
    expect(own.permissions?.sort()).toEqual(['profile.locale', 'users.read'])
    const seen = await app.service('users').get(operator.id, as(admin))
    expect(seen.roleIds).toEqual(own.roleIds)
    expect(seen).not.toHaveProperty('permissions')
  })

  it('lists the holders of a role', async () => {
    const page = await app.service('users').find({ ...as(admin), query: { roleId: await roleIdOf(app, 'us01user') } })
    expect(page.data.map((u) => u.tuId)).toEqual(['us01user'])
  })

  it('is not assigned through users.patch', async () => {
    await expect(
      app.service('users').patch(other.id, { roleIds: [await roleIdOf(app, 'admin')] } as never, as(admin))
    ).rejects.toMatchObject({ code: 400 })
  })
})

describe('users: account enable / disable — write under users.enable', () => {
  it('admin disables and re-enables an account', async () => {
    expect((await app.service('users').patch(other.id, { enabled: false }, as(admin))).enabled).toBe(false)
    expect((await app.service('users').patch(other.id, { enabled: true }, as(admin))).enabled).toBe(true)
  })

  it.each([
    ['operator', () => operator],
    ['user', () => member]
  ])('%s cannot disable an account', async (_role, who) => {
    await expect(
      app.service('users').patch(other.id, { enabled: false }, as(who()))
    ).rejects.toMatchObject({ code: 403 })
  })
})

describe('users: directory fields — writable by nobody', () => {
  it.each(['tuId', 'givenName', 'surname', 'email', 'authSource', 'id', 'createdAt'])(
    'admin cannot write %s',
    async (field) => {
      await expect(
        app.service('users').patch(other.id, { [field]: 'x' } as never, as(admin))
      ).rejects.toMatchObject({ code: 400 })
    }
  )

  it('rejects an empty patch', async () => {
    await expect(app.service('users').patch(other.id, {}, as(admin))).rejects.toMatchObject({ code: 400 })
  })
})

describe('users: own locale — write under profile.locale (ADR 0027)', () => {
  it.each([
    ['admin', () => admin],
    ['operator', () => operator],
    ['user', () => member]
  ])('%s sets their own locale, German until then', async (_role, who) => {
    expect((await app.service('users').get(who().id)).locale).toBe('de')
    const result = await app.service('locales').create({ locale: 'en' }, as(who()))
    expect(result).toMatchObject({ id: who().id, locale: 'en' })
    await app.service('locales').create({ locale: 'de' }, as(who()))
  })

  it('is refused without profile.locale', async () => {
    const without = await makeUser(app, 'us03none')
    await expect(app.service('locales').create({ locale: 'en' }, as(without))).rejects.toMatchObject({ code: 403 })
  })

  it('refuses a locale the application does not have', async () => {
    await expect(app.service('locales').create({ locale: 'fr' } as never, as(member))).rejects.toMatchObject({ code: 400 })
  })

  it('cannot address anybody else', async () => {
    await expect(
      app.service('locales').create({ locale: 'en', userId: other.id } as never, as(member))
    ).rejects.toMatchObject({ code: 400 })
    await expect(app.service('users').patch(other.id, { locale: 'en' } as never, as(admin))).rejects.toMatchObject({ code: 400 })
  })

  it('refuses unauthenticated calls', async () => {
    await expect(app.service('locales').create({ locale: 'en' }, { provider: 'rest' })).rejects.toMatchObject({ code: 401 })
  })
})
