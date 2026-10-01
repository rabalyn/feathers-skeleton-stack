import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { makeUser, roleIdOf } from '../support/roles.js'

// Personal preferences (decided 2026-10-02, ADR 0014): every signed-in
// person keeps their own, through `profile.preferences` on the `everyone`
// role, and sees nobody else's.

let app: Application
let member: User
let other: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

beforeAll(async () => {
  ;({ app } = await createTestApp())
  member = await makeUser(app, 'us01user', 'user')
  other = await makeUser(app, 'us02user', 'user')
})

afterAll(async () => {
  await app.teardown()
})

describe('preferences', () => {
  it('sets a key, replaces it on the next set and removes it', async () => {
    const service = app.service('preferences')
    const first = await service.create({ key: 'navOrder', value: ['documents', 'profile'] }, as(member))
    expect(first).toMatchObject({ userId: member.id, key: 'navOrder', value: ['documents', 'profile'] })

    const second = await service.create({ key: 'navOrder', value: ['profile', 'documents'] }, as(member))
    expect(second).toMatchObject({ id: first.id, value: ['profile', 'documents'] })
    await expect(service.find(as(member))).resolves.toMatchObject({ total: 1, data: [{ id: first.id, value: ['profile', 'documents'] }] })

    await service.remove(first.id, as(member))
    await expect(service.find(as(member))).resolves.toMatchObject({ total: 0 })
  })

  it('keeps every person to their own rows (ADR 0011)', async () => {
    const service = app.service('preferences')
    const mine = await service.create({ key: 'navOrder', value: ['profile'] }, as(member))
    // The owner is always the caller, whatever the request says.
    await expect(service.create({ key: 'navOrder', value: [], userId: member.id } as never, as(other))).rejects.toMatchObject({ code: 400 })

    await expect(service.find(as(other))).resolves.toMatchObject({ total: 0 })
    await expect(service.find({ ...as(other), query: { userId: member.id } })).resolves.toMatchObject({ total: 0 })
    await expect(service.get(mine.id, as(other))).rejects.toMatchObject({ code: 404 })
    await expect(service.remove(mine.id, as(other))).rejects.toMatchObject({ code: 404 })
    await service.remove(mine.id, as(member))
  })

  it('checks the value against the key’s schema (ADR 0005)', async () => {
    const service = app.service('preferences')
    await expect(service.create({ key: 'unknown', value: [] } as never, as(member))).rejects.toMatchObject({ code: 400 })
    await expect(service.create({ key: 'navOrder', value: 'profile' }, as(member))).rejects.toMatchObject({ code: 400 })
    await expect(service.create({ key: 'navOrder', value: ['profile', 'profile'] }, as(member))).rejects.toMatchObject({ code: 400 })
    await expect(service.create({ key: 'navOrder', value: ['Not A Route'] }, as(member))).rejects.toMatchObject({ code: 400 })
  })

  it('refuses whoever the everyone role stops granting it to', async () => {
    const everyone = await roleIdOf(app, 'everyone')
    const admin = await makeUser(app, 'ad01admn', 'admin')
    const { permissions } = await app.service('roles').get(everyone)
    await app.service('roles').patch(everyone, { permissions: permissions!.filter((key) => key !== 'profile.preferences') }, as(admin))
    try {
      await expect(app.service('preferences').find(as(member))).rejects.toMatchObject({ code: 403 })
      await expect(app.service('preferences').create({ key: 'navOrder', value: [] }, as(member))).rejects.toMatchObject({ code: 403 })
    } finally {
      await app.service('roles').patch(everyone, { permissions }, as(admin))
    }
  })

  it('is deleted on erasure (ADR 0013)', async () => {
    await app.service('preferences').create({ key: 'navOrder', value: ['profile'] }, as(other))
    await app.get('knex').raw('SELECT erase_user(?)', [other.id])
    expect(await app.get('knex')('preferences').where({ userId: other.id })).toEqual([])
  })
})
