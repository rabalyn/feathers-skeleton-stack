import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { grantRoles, type SeededRole } from '../support/roles.js'

// ADR 0008 (directory lookup) against the stack's LDAPS test directory, and
// the directory row of ADR 0011's matrix. Seeded people: ad01admn Ada Admin,
// op01oper Otto Operator, us01user Uma User, us02othr Olaf Other.

let app: Application
let admin: User
let operator: User
let member: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })
const find = (who: User, query: Record<string, unknown>) =>
  app.service('directory').find({ ...as(who), query: query as never })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const users = app.service('users')
  const make = async (tuId: string, role: SeededRole) => {
    const created = await users.create({ tuId, givenName: tuId, surname: 'T', email: `${tuId}@example.org`, authSource: 'saml' })
    return grantRoles(app, created.id, [role])
  }
  // Accounts of people who have logged in; us02othr never has.
  admin = await make('ad01admn', 'admin')
  operator = await make('op01oper', 'operator')
  member = await make('us01user', 'user')
})

afterAll(async () => {
  await app.teardown()
})

describe('directory: read for admin and operator only', () => {
  it.each([
    ['admin', () => admin],
    ['operator', () => operator]
  ])('%s finds people by TU-ID prefix, with their account if they have one', async (_role, who) => {
    const page = await find(who(), { q: 'us0' })
    expect(page).toMatchObject({ total: 2, skip: 0, truncated: false })
    const byTuId = Object.fromEntries(page.data.map((entry) => [entry.tuId, entry]))
    expect(byTuId.us01user).toEqual({
      tuId: 'us01user',
      givenName: 'Uma',
      surname: 'User',
      email: 'uma.user@example.org',
      userId: member.id
    })
    expect(byTuId.us02othr).toMatchObject({ givenName: 'Olaf', surname: 'Other', userId: null })
  })

  it('user may not look anybody up', async () => {
    await expect(find(member, { q: 'us0' })).rejects.toMatchObject({ code: 403 })
  })

  it('rejects unauthenticated calls and every other method', async () => {
    await expect(app.service('directory').find({ provider: 'rest', query: { q: 'us' } })).rejects.toMatchObject({
      code: 401
    })
    const server = await app.listen(0)
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/directory`
    expect((await fetch(base, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(405)
    expect((await fetch(`${base}/us01user`)).status).toBe(405)
  })
})

describe('searching', () => {
  it('accepts two-character terms, for historical TU-IDs', async () => {
    const page = await find(admin, { q: 'ad' })
    expect(page.data.map((entry) => entry.tuId)).toEqual(['ad01admn'])
  })

  it('matches every word against name, surname, mail or TU-ID', async () => {
    expect((await find(admin, { q: 'Uma Us' })).data.map((e) => e.tuId)).toEqual(['us01user'])
    expect((await find(admin, { q: 'otto.op' })).data.map((e) => e.tuId)).toEqual(['op01oper'])
    expect((await find(admin, { q: 'Uma Other' })).total).toBe(0)
  })

  it('treats filter syntax as text', async () => {
    for (const q of ['**', ')(cn=*', '*)(|(objectClass=*']) {
      await expect(find(admin, { q })).resolves.toMatchObject({ total: 0, data: [] })
    }
  })

  it('never returns more than the four directory attributes', async () => {
    const page = await find(admin, { q: 'us01' })
    expect(Object.keys(page.data[0] ?? {}).sort()).toEqual(['email', 'givenName', 'surname', 'tuId', 'userId'])
  })

  it('pages within the matches', async () => {
    const page = await find(admin, { q: 'us0', $limit: 1, $skip: 1 })
    expect(page).toMatchObject({ total: 2, limit: 1, skip: 1 })
    expect(page.data).toHaveLength(1)
  })

  it.each([
    ['a one-character term', { q: 'a' }],
    ['a blank term', { q: '   ' }],
    ['no term', {}],
    ['an overlong term', { q: 'x'.repeat(65) }],
    ['an unknown parameter', { q: 'us', cn: 'x' }],
    ['a page size over the cap', { q: 'us', $limit: 51 }]
  ])('rejects %s', async (_case, query) => {
    await expect(find(admin, query)).rejects.toMatchObject({ code: 400 })
  })
})

describe('when the directory cannot answer', () => {
  it.each([
    ['is unreachable', { ldapUrl: 'ldaps://ldap:1' }],
    ['refuses the service account', { ldapBindPassword: 'wrong-password' }]
  ])('answers 503 when it %s', async (_case, ldap) => {
    const { app: broken } = await createTestApp({ ldap })
    try {
      await expect(broken.service('directory').find({ ...as(admin), query: { q: 'us' } })).rejects.toMatchObject({
        code: 503
      })
    } finally {
      await broken.teardown()
    }
  })
})
