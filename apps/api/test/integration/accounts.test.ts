import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountFor } from '../../src/accounts.js'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { makeUser } from '../support/roles.js'
import { db } from '../support/worker-database.js'

// ADR 0009: an account made before the person's first login, from the
// directory alone, by product code inside the write that needs it. Against
// the stack's LDAPS test directory, whose bulk people (bk001blk, Bea Bulk001,
// bea.bulk001@example.org, ...) have never logged in.

let app: Application
let operator: User

const roleKeys = (userId: string) =>
  db()('user_roles').join('roles', 'roles.id', 'user_roles.role_id').where({ user_id: userId }).pluck('key')
const created = (userId: string) => db()('audit_events').where({ action: 'users.create', resource_id: userId })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  operator = await makeUser(app, 'op01oper', [])
})

afterAll(async () => {
  await app.teardown()
})

describe('accountFor', () => {
  it('makes the account from the directory, with the default role, and records who caused it', async () => {
    const knex = app.get('knex')
    const account = await knex.transaction((trx) => accountFor(app, trx, 'bk001blk', { actorId: operator.id }))
    expect(account.created).toBe(true)
    const row = await db()('users').where({ id: account.id }).first()
    expect(row).toMatchObject({
      tu_id: 'bk001blk',
      given_name: 'Bea',
      surname: 'Bulk001',
      email: 'bea.bulk001@example.org',
      auth_source: 'saml',
      enabled: true,
      locale: 'de',
      last_login_at: null
    })
    // What a first login would give (ADR 0011).
    expect(await roleKeys(account.id)).toEqual(['user'])
    const events = await created(account.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actor_id: operator.id, resource_type: 'users' })
  })

  it('returns an existing account as it is, without asking the directory', async () => {
    const knex = app.get('knex')
    const first = await knex.transaction((trx) => accountFor(app, trx, 'bk002blk', { actorId: operator.id }))
    const again = await knex.transaction((trx) => accountFor(app, trx, 'bk002blk', { actorId: null }))
    expect(again).toEqual({ id: first.id, created: false })
    expect(await created(first.id)).toHaveLength(1)
    // An account the directory no longer knows (the person left) is still
    // found: the record stays with what they hold.
    const left = await makeUser(app, 'gone0001', [])
    await expect(knex.transaction((trx) => accountFor(app, trx, 'gone0001', { actorId: null }))).resolves.toEqual({
      id: left.id,
      created: false
    })
  })

  it('refuses a TU-ID the directory does not know, and makes nothing', async () => {
    const knex = app.get('knex')
    for (const tuId of ['nobody01', 'bk003blk)(cn=*', '*']) {
      await expect(knex.transaction((trx) => accountFor(app, trx, tuId, { actorId: operator.id }))).rejects.toMatchObject({
        code: 400
      })
    }
    expect(await db()('users').whereIn('tu_id', ['nobody01', 'bk003blk', 'bk003blk)(cn=*', '*'])).toEqual([])
  })

  it('belongs to the write that needs it: rolled back with it', async () => {
    const knex = app.get('knex')
    await expect(
      knex.transaction(async (trx) => {
        await accountFor(app, trx, 'bk004blk', { actorId: operator.id })
        throw new Error('the loan failed')
      })
    ).rejects.toThrow('the loan failed')
    expect(await db()('users').where({ tu_id: 'bk004blk' })).toEqual([])
  })
})
