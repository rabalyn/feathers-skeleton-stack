import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PERMISSION_KEYS } from '../../src/abilities.js'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import { grantRoles, makeUser, roleIdOf } from '../support/roles.js'
import { db } from '../support/worker-database.js'

// ADR 0011: roles composed of catalogue permissions, managed by admins only,
// with the safeguards that keep the application administrable.

let app: Application
let admin: User
let operator: User
let member: User
let other: User
let breakGlass: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

const NAME = { de: 'Prüfung', en: 'Review' }

beforeAll(async () => {
  ;({ app } = await createTestApp())
  admin = await makeUser(app, 'ad01admn', 'admin')
  operator = await makeUser(app, 'op01oper', 'operator')
  member = await makeUser(app, 'us01user', 'user')
  other = await makeUser(app, 'us02othr', 'user')
  const local = await app.service('users').create({ tuId: null, givenName: null, surname: null, email: 'bg@example.test', authSource: 'local' })
  breakGlass = await grantRoles(app, local.id, ['admin'])
})

afterAll(async () => {
  await app.teardown()
})

const auditOf = (action: string, resourceId: string) =>
  db()('audit_events').where({ action, resource_id: resourceId }).orderBy('occurred_at')

describe('roles: reading', () => {
  it('shows admins every role with what it grants, admin the whole catalogue', async () => {
    const page = await app.service('roles').find(as(admin))
    const byKey = Object.fromEntries(page.data.map((role) => [role.key, role]))
    expect(byKey.admin).toMatchObject({ kind: 'admin', name: { de: 'Administration' }, permissions: [...PERMISSION_KEYS] })
    expect(byKey.operator).toMatchObject({ kind: 'seeded', name: { en: 'Operations' } })
    expect(byKey.operator?.permissions?.sort()).toEqual(['audit-events.read', 'directory.read', 'documents.all', 'sessions.read', 'users.read'])
    expect(byKey.user).toMatchObject({ kind: 'seeded', permissions: ['documents.own'] })
  })

  it('shows whoever reads users the names only', async () => {
    const page = await app.service('roles').find(as(operator))
    expect(page.total).toBeGreaterThanOrEqual(3)
    for (const role of page.data) {
      expect(Object.keys(role).sort()).toEqual(['id', 'key', 'kind', 'name'])
    }
  })

})

describe('roles: managing — admin only', () => {
  it('creates a custom role, audited, and it grants on the next call', async () => {
    const role = await app.service('roles').create({ key: 'reviewer', name: NAME, permissions: ['audit-events.read'] }, as(admin))
    expect(role).toMatchObject({ key: 'reviewer', kind: 'custom', name: NAME, permissions: ['audit-events.read'] })
    expect(await auditOf('roles.create', role.id)).toEqual([expect.objectContaining({ actor_id: admin.id })])

    const before = await app.service('audit-events').find(as(other))
    await app.service('user-roles').patch(other.id, { roleIds: [...other.roleIds, role.id] }, as(admin))
    const after = await app.service('audit-events').find(as(other))
    expect(after.total).toBeGreaterThan(before.total)

    await app.service('user-roles').patch(other.id, { roleIds: other.roleIds }, as(admin))
    await app.service('roles').remove(role.id, as(admin))
  })

  it("changes a seeded role's permissions and name, audited with what was added and removed", async () => {
    const userRole = await roleIdOf(app, 'user')
    await app.service('roles').patch(userRole, { permissions: ['documents.own', 'directory.read'] }, as(admin))
    await expect(app.service('directory').find({ ...as(member), query: { q: 'zz' } })).resolves.toBeDefined()
    await app.service('roles').patch(userRole, { permissions: ['documents.own'], name: { de: 'Mitglied', en: 'Member' } }, as(admin))
    await expect(app.service('directory').find({ ...as(member), query: { q: 'zz' } })).rejects.toMatchObject({ code: 403 })

    const events = await auditOf('roles.patch', userRole)
    expect(events.map((event) => event.detail)).toEqual([
      { added: ['directory.read'], removed: [] },
      { added: [], removed: ['directory.read'], name: { from: { de: 'Benutzer', en: 'User' }, to: { de: 'Mitglied', en: 'Member' } } }
    ])
    await app.service('roles').patch(userRole, { name: { de: 'Benutzer', en: 'User' } }, as(admin))
  })

  it.each([
    ['operator', () => operator],
    ['user', () => member]
  ])('%s can neither create, change nor delete a role, nor assign one', async (_role, who) => {
    const userRole = await roleIdOf(app, 'user')
    await expect(app.service('roles').create({ key: 'mine', name: NAME }, as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('roles').patch(userRole, { name: NAME }, as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('user-roles').patch(who().id, { roleIds: [await roleIdOf(app, 'admin')] }, as(who()))).rejects.toMatchObject({
      code: 403
    })
  })

  it('even an operator granted every catalogue permission cannot manage roles', async () => {
    const operatorRole = await app.service('roles').get(await roleIdOf(app, 'operator'))
    await app.service('roles').patch(operatorRole.id, { permissions: [...PERMISSION_KEYS] }, as(admin))
    try {
      await expect(app.service('roles').create({ key: 'escalate', name: NAME }, as(operator))).rejects.toMatchObject({ code: 403 })
      await expect(
        app.service('user-roles').patch(operator.id, { roleIds: [await roleIdOf(app, 'admin')] }, as(operator))
      ).rejects.toMatchObject({ code: 403 })
      // Configuration, on the other hand, is theirs now (ADR 0011: everything grantable).
      await expect(app.service('settings').find(as(operator))).resolves.toBeDefined()
    } finally {
      await app.service('roles').patch(operatorRole.id, { permissions: operatorRole.permissions ?? [] }, as(admin))
    }
  })
})

describe('roles: safeguards', () => {
  it('refuses a permission the catalogue does not declare', async () => {
    await expect(
      app.service('roles').create({ key: 'bogus', name: NAME, permissions: ['roles.manage'] }, as(admin))
    ).rejects.toMatchObject({ code: 400 })
    await expect(
      app.service('roles').patch(await roleIdOf(app, 'operator'), { permissions: ['nope'] }, as(admin))
    ).rejects.toMatchObject({ code: 400 })
  })

  it('refuses a taken key, a malformed one, and a name missing a locale', async () => {
    await expect(app.service('roles').create({ key: 'operator', name: NAME }, as(admin))).rejects.toMatchObject({ code: 409 })
    await expect(app.service('roles').create({ key: 'Bad Key', name: NAME }, as(admin))).rejects.toMatchObject({ code: 400 })
    await expect(app.service('roles').create({ key: 'half', name: { de: 'Halb' } } as never, as(admin))).rejects.toMatchObject({ code: 400 })
  })

  it('keeps admin fixed', async () => {
    const adminRole = await roleIdOf(app, 'admin')
    await expect(app.service('roles').patch(adminRole, { permissions: [] }, as(admin))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('roles').patch(adminRole, { name: NAME }, as(admin))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('roles').remove(adminRole, as(admin))).rejects.toMatchObject({ code: 403 })
  })

  it('keeps the seeded roles', async () => {
    for (const key of ['operator', 'user']) {
      await expect(app.service('roles').remove(await roleIdOf(app, key), as(admin))).rejects.toMatchObject({ code: 403 })
    }
  })

  it('refuses to delete a custom role while somebody holds it, then deletes it, audited', async () => {
    const role = await app.service('roles').create({ key: 'held', name: NAME }, as(admin))
    await app.service('user-roles').patch(member.id, { roleIds: [...member.roleIds, role.id] }, as(admin))
    await expect(app.service('roles').remove(role.id, as(admin))).rejects.toMatchObject({ code: 409 })
    await app.service('user-roles').patch(member.id, { roleIds: member.roleIds }, as(admin))
    await expect(app.service('roles').remove(role.id, as(admin))).resolves.toMatchObject({ id: role.id })
    expect(await auditOf('roles.remove', role.id)).toEqual([expect.objectContaining({ actor_id: admin.id })])
  })

  it('keeps admin on the break-glass account', async () => {
    await expect(
      app.service('user-roles').patch(breakGlass.id, { roleIds: [await roleIdOf(app, 'user')] }, as(admin))
    ).rejects.toMatchObject({ code: 400 })
    expect((await app.service('users').get(breakGlass.id)).roleIds).toEqual([await roleIdOf(app, 'admin')])
  })

  it('refuses a role that does not exist', async () => {
    await expect(
      app.service('user-roles').patch(member.id, { roleIds: ['00000000-0000-7000-8000-000000000000'] }, as(admin))
    ).rejects.toMatchObject({ code: 400 })
  })
})

describe('user-roles: several roles add up', () => {
  it('grants the union of the roles, and none leaves just the baseline', async () => {
    const [operatorRole, userRole] = await Promise.all([roleIdOf(app, 'operator'), roleIdOf(app, 'user')])
    const both = await app.service('user-roles').patch(other.id, { roleIds: [userRole, operatorRole] }, as(admin))
    expect(both.roleIds.sort()).toEqual([operatorRole, userRole].sort())
    const self = await app.service('users').get(other.id, as(other))
    expect(self.permissions).toEqual(expect.arrayContaining(['documents.own', 'documents.all', 'users.read']))
    expect((await app.service('users').find(as(other))).total).toBeGreaterThan(1)

    await app.service('user-roles').patch(other.id, { roleIds: [] }, as(admin))
    const bare = await app.service('users').get(other.id, as(other))
    expect(bare.permissions).toEqual([])
    // The baseline stays: the own record, but no documents.
    expect((await app.service('users').find(as(other))).total).toBe(1)
    await expect(app.service('documents').find(as(other))).rejects.toMatchObject({ code: 403 })

    await app.service('user-roles').patch(other.id, { roleIds: [userRole] }, as(admin))
  })

  it('reads the assignment of one user, for admins', async () => {
    await expect(app.service('user-roles').get(member.id, as(admin))).resolves.toEqual({ id: member.id, roleIds: member.roleIds })
    await expect(app.service('user-roles').get(member.id, as(operator))).rejects.toMatchObject({ code: 403 })
  })
})

describe('roles: the baseline', () => {
  it("lets everybody read the names of their own roles, and no other role", async () => {
    const page = await app.service('roles').find(as(member))
    expect(page.data.map((role) => role.key)).toEqual(['user'])
    expect(Object.keys(page.data[0]!).sort()).toEqual(['id', 'key', 'kind', 'name'])
    await expect(app.service('roles').get(await roleIdOf(app, 'admin'), as(member))).rejects.toMatchObject({ code: 404 })
  })
})
