import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import {  } from '../support/roles.js'
import { grantRoles } from '../support/roles.js'

// ADR 0013 over HTTP: erasure is the admin's alone (ADR 0011), refused for
// oneself and the break-glass account, audited, and ends the person's
// sessions and export objects with their identifiers.

let app: Application
let base: string
let admin: User
let operator: User
let member: User
let breakGlass: User
const knex = () => app.get('knex')

const tokenFor = async (user: User) => {
  const { session } = await app.get('sessions').issue(user.id)
  return app.service('authentication').createAccessToken({ sid: session.id }, { subject: user.id })
}

const erase = async (actor: User, userId: string) =>
  fetch(`${base}/erasures`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await tokenFor(actor)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ userId })
  })

let count = 0
const person = async () => {
  count += 1
  const tuId = `er${String(count).padStart(2, '0')}pers`
  return app.service('users').create({ tuId, givenName: 'Erika', surname: 'Muster', email: `${tuId}@example.test`, authSource: 'saml' })
}

beforeAll(async () => {
  ;({ app } = await createTestApp())
  const server = await app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const users = app.service('users')
  admin = await grantRoles(app, (await person()).id, ['admin'])
  operator = await grantRoles(app, (await person()).id, ['operator'])
  member = await grantRoles(app, (await person()).id, ['user'])
  breakGlass = await users.create({ tuId: null, givenName: null, surname: null, email: 'bg@example.test', authSource: 'local' })
})

afterAll(async () => {
  await app.teardown()
})

describe('erasure (ADR 0011, 0013)', () => {
  it('is refused to operators and users', async () => {
    const target = await person()
    expect((await erase(operator, target.id)).status).toBe(403)
    expect((await erase(member, target.id)).status).toBe(403)
    expect((await knex()('users').where({ id: target.id }).first()).tuId).not.toBeNull()
  })

  it('erases a person: identifiers, sessions, export objects; audited and logged', async () => {
    const target = await person()
    const token = await tokenFor(target)
    const [row] = await knex()('dataExports').insert({ subjectId: target.id, requestedBy: target.id }).returning('id')
    const exportId = (row as { id: string }).id
    await app.get('exports').put(exportId, Readable.from(Buffer.from('zip')), 3, 'application/zip')
    const published = new Promise<User>((resolve) =>
      app.service('users').once('patched', (user: User) => user.id === target.id && resolve(user))
    )

    const response = await erase(admin, target.id)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ userId: target.id, erasedAt: expect.any(String) })

    expect(await published).toMatchObject({ id: target.id, tuId: null, email: null, enabled: false, erasedAt: expect.any(String) })
    expect(await knex()('users').where({ id: target.id }).first()).toMatchObject({
      tuId: null,
      givenName: null,
      surname: null,
      email: null,
      enabled: false
    })
    expect(await knex()('authSessions').where({ userId: target.id })).toEqual([])
    expect(await app.get('exports').get(exportId)).toBeUndefined()
    expect(await knex()('erasures').where({ userId: target.id })).toHaveLength(1)
    expect(await knex()('auditEvents').where({ action: 'users.erase', resourceId: target.id })).toEqual([
      expect.objectContaining({ actorId: admin.id, resourceType: 'users', detail: {} })
    ])

    // Logged out at once: the session its token names is gone.
    const after = await fetch(`${base}/users/${target.id}`, { headers: { authorization: `Bearer ${token}` } })
    expect(after.status).toBe(401)
  })

  it('refuses oneself, the break-glass account, an unknown id and a second erasure', async () => {
    expect((await erase(admin, admin.id)).status).toBe(400)
    expect((await erase(admin, breakGlass.id)).status).toBe(400)
    expect((await erase(admin, '01900000-0000-7000-8000-000000000000')).status).toBe(400)
    const target = await person()
    expect((await erase(admin, target.id)).status).toBe(201)
    expect((await erase(admin, target.id)).status).toBe(409)
    expect(await knex()('users').where({ id: admin.id }).first()).toMatchObject({ enabled: true })
  })

  it('shows erased accounts as such to admins', async () => {
    const target = await person()
    await erase(admin, target.id)
    const response = await fetch(`${base}/users?id=${target.id}`, {
      headers: { authorization: `Bearer ${await tokenFor(admin)}` }
    })
    const page = (await response.json()) as { data: User[] }
    expect(page.data).toEqual([expect.objectContaining({ id: target.id, tuId: null, erasedAt: expect.any(String) })])
  })
})
