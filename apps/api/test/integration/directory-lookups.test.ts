import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { allBut, makeUser } from '../support/roles.js'

// ADR 0008: one person by the exact value of an attribute the product names
// as a lookup, against the stack's LDAPS test directory, whose people carry
// made-up card numbers (containers/ldap/seed/cards.ldif). Under
// directory.read, like a search.

let app: Application
let reader: User
let member: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })
const lookup = (who: User, data: Record<string, unknown>) => app.service('directory-lookups').create(data as never, as(who))

beforeAll(async () => {
  ;({ app } = await createTestApp({
    productDirectory: { attributes: [], apply: async () => {}, lookups: { cardNumber: 'idmUserAssignedCardSnMifare' } }
  }))
  reader = await makeUser(app, 'op01oper', ['directory.read'], { surname: 'T' })
  member = await makeUser(app, 'us01user', allBut('directory.read'), { surname: 'T' })
})

afterAll(async () => {
  await app.teardown()
})

describe('directory-lookups', () => {
  it("finds the one person holding the value, with their account if they have one, and nothing of the attribute's", async () => {
    await expect(lookup(reader, { by: 'cardNumber', value: '0412A0B1C2D3E6' })).resolves.toEqual({
      tuId: 'us01user',
      givenName: 'Uma',
      surname: 'User',
      email: 'uma.user@example.org',
      userId: member.id
    })
    await expect(lookup(reader, { by: 'cardNumber', value: '0412A0B1C2D3E4' })).resolves.toMatchObject({ tuId: 'ad01admn', userId: null })
  })

  it('matches the value exactly, with filter syntax as text', async () => {
    for (const value of ['0412A0B1C2D3E', '0412A0B1C2D3E*', '*', '0412A0B1C2D3E6)(cn=*']) {
      await expect(lookup(reader, { by: 'cardNumber', value })).rejects.toMatchObject({ code: 404, data: { reason: 'not-found' } })
    }
  })

  it('refuses a lookup the product does not name, and a value with control characters', async () => {
    await expect(lookup(reader, { by: 'mail', value: 'uma.user@example.org' })).rejects.toMatchObject({ code: 400 })
    await expect(lookup(reader, { by: 'toString', value: 'x' })).rejects.toMatchObject({ code: 400 })
    await expect(lookup(reader, { by: 'cardNumber', value: '0412A0B1C2D3E6\n' })).rejects.toMatchObject({ code: 400 })
  })

  it('may not look anybody up without directory.read', async () => {
    await expect(lookup(member, { by: 'cardNumber', value: '0412A0B1C2D3E6' })).rejects.toMatchObject({ code: 403 })
    await expect(app.service('directory-lookups').create({ by: 'cardNumber', value: 'x' }, { provider: 'rest' })).rejects.toMatchObject({
      code: 401
    })
  })
})

describe('a directory that cannot be reached', () => {
  it('answers 503', async () => {
    const { app: down } = await createTestApp({
      productDirectory: { attributes: [], apply: async () => {}, lookups: { cardNumber: 'idmUserAssignedCardSnMifare' } },
      ldap: { ldapUrl: 'ldaps://ldap:1' }
    })
    try {
      const user = await makeUser(down, 'do01down', ['directory.read'], { surname: 'T' })
      await expect(
        down.service('directory-lookups').create({ by: 'cardNumber', value: '0412A0B1C2D3E6' }, as(user))
      ).rejects.toMatchObject({ code: 503 })
    } finally {
      await down.teardown()
    }
  })
})
