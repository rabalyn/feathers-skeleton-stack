import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PERMISSION_KEYS } from '../../src/abilities.js'
import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'
import { createTestApp } from '../support/app.js'
import type { Role } from '../../src/services/roles/roles.schema.js'
import { emptyEveryone, grantRoles, makeUser, roleIdOf } from '../support/roles.js'
import { db } from '../support/worker-database.js'

// ADR 0011: roles composed of catalogue permissions, managed by admins only,
// with the safeguards that keep the application administrable. The users
// hold roles of the test's own (ADR 0035); what the migrations seed
// `everyone`, `operator` and `user` with is checked only where the stack is
// the skeleton's, since a product may change it.

const SKELETON = process.env.PRODUCT === 'feathers-skeleton'

let app: Application
let admin: User
let operator: User
let member: User
let other: User
let breakGlass: User

const as = (user: User) => ({ provider: 'rest' as const, user, authenticated: true })

const NAME = { de: 'Prüfung', en: 'Review' }

// What the migration seeds `everyone` with: the former baseline beyond the
// fixed core (decided 2026-10-01).
const SKELETON_EVERYONE = [
  'api-tokens.own',
  'audit-events.own',
  'files.own',
  'files.upload',
  'profile.avatar',
  'profile.locale',
  'profile.preferences',
  'roles.own-names'
]

// The roles as the migrations left them, before `everyone` is emptied.
let seeded: Record<string, Role>

beforeAll(async () => {
  ;({ app } = await createTestApp({ seededEveryone: true }))
  seeded = Object.fromEntries((await app.service('roles').find({ paginate: false })).map((role) => [role.key, role]))
  await emptyEveryone()
  admin = await makeUser(app, 'ad01admn', 'admin')
  operator = await makeUser(app, 'op01oper', ['users.read'])
  member = await makeUser(app, 'us01user', ['documents.own', 'roles.own-names'])
  other = await makeUser(app, 'us02othr', ['documents.own', 'audit-events.own'])
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
    for (const key of ['operator', 'user']) expect(byKey[key]).toMatchObject({ kind: 'seeded', permissions: expect.any(Array) })
    expect(byKey.everyone).toMatchObject({ kind: 'everyone', permissions: [] })
    expect(byKey.us01user?.permissions?.sort()).toEqual(['documents.own', 'roles.own-names'])
  })

  it('shows whoever reads users the names only', async () => {
    const page = await app.service('roles').find(as(operator))
    expect(page.total).toBeGreaterThanOrEqual(3)
    for (const role of page.data) {
      expect(Object.keys(role).sort()).toEqual(['id', 'key', 'kind', 'name'])
    }
  })

})

// The seeded defaults of ADR 0011, as the migrations leave them. A product
// changes them in migrations of its own, so they are the skeleton's only
// (ADR 0035).
describe.runIf(SKELETON)("the skeleton's seeded roles", () => {
  it('grant the defaults of ADR 0011', () => {
    expect(seeded.operator).toMatchObject({ kind: 'seeded', name: { en: 'Operations' } })
    expect(seeded.operator?.permissions?.sort()).toEqual([
      'audit-events.read',
      'directory.read',
      'documents.all',
      'locations.read',
      'sessions.read',
      'sites.read',
      'users.read'
    ])
    expect(seeded.user).toMatchObject({ kind: 'seeded', name: { de: 'Benutzer', en: 'User' } })
    expect(seeded.user?.permissions?.sort()).toEqual(['documents.own', 'locations.read', 'sites.read'])
    expect(seeded.everyone).toMatchObject({ kind: 'everyone', name: { en: 'Everyone signed in' } })
    expect(seeded.everyone?.permissions?.sort()).toEqual(SKELETON_EVERYONE)
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
    // Whatever it grants in this stack (ADR 0035), held by the member for now.
    const userRole = await roleIdOf(app, 'user')
    const { name, permissions = [] } = seeded.user!
    const without = permissions.filter((key) => key !== 'directory.read')
    await app.service('roles').patch(userRole, { permissions: without }, as(admin))
    await app.service('user-roles').patch(member.id, { roleIds: [...member.roleIds, userRole] }, as(admin))
    const earlier = (await auditOf('roles.patch', userRole)).length

    await app.service('roles').patch(userRole, { permissions: [...without, 'directory.read'] }, as(admin))
    await expect(app.service('directory').find({ ...as(member), query: { q: 'zz' } })).resolves.toBeDefined()
    await app.service('roles').patch(userRole, { permissions: without, name: { de: 'Mitglied', en: 'Member' } }, as(admin))
    await expect(app.service('directory').find({ ...as(member), query: { q: 'zz' } })).rejects.toMatchObject({ code: 403 })

    const events = (await auditOf('roles.patch', userRole)).slice(earlier)
    expect(events.map((event) => event.detail)).toEqual([
      { added: ['directory.read'], removed: [] },
      { added: [], removed: ['directory.read'], name: { from: name, to: { de: 'Mitglied', en: 'Member' } } }
    ])
    await app.service('user-roles').patch(member.id, { roleIds: member.roleIds }, as(admin))
    await app.service('roles').patch(userRole, { name, permissions }, as(admin))
  })

  it.each([
    ['users.read', () => operator],
    ['documents.own', () => member]
  ])('holding %s, one can neither create, change nor delete a role, nor assign one', async (_role, who) => {
    const userRole = await roleIdOf(app, 'user')
    await expect(app.service('roles').create({ key: 'mine', name: NAME }, as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('roles').patch(userRole, { name: NAME }, as(who()))).rejects.toMatchObject({ code: 403 })
    await expect(app.service('user-roles').patch(who().id, { roleIds: [await roleIdOf(app, 'admin')] }, as(who()))).rejects.toMatchObject({
      code: 403
    })
  })

  it('even an operator granted every catalogue permission cannot manage roles', async () => {
    const operatorRole = await app.service('roles').get(await roleIdOf(app, 'op01oper'))
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
  it('grants the union of the roles, and none leaves what everyone holds', async () => {
    const [operatorRole, otherRole, everyone] = await Promise.all([roleIdOf(app, 'op01oper'), roleIdOf(app, 'us02othr'), roleIdOf(app, 'everyone')])
    const both = await app.service('user-roles').patch(other.id, { roleIds: [otherRole, operatorRole] }, as(admin))
    expect(both.roleIds.sort()).toEqual([operatorRole, otherRole].sort())
    const self = await app.service('users').get(other.id, as(other))
    expect(self.permissions?.sort()).toEqual(['audit-events.own', 'documents.own', 'users.read'])
    expect((await app.service('users').find(as(other))).total).toBeGreaterThan(1)

    await app.service('roles').patch(everyone, { permissions: ['profile.locale'] }, as(admin))
    try {
      await app.service('user-roles').patch(other.id, { roleIds: [] }, as(admin))
      const bare = await app.service('users').get(other.id, as(other))
      expect(bare.permissions).toEqual(['profile.locale'])
      // The own record stays, but no documents.
      expect((await app.service('users').find(as(other))).total).toBe(1)
      await expect(app.service('documents').find(as(other))).rejects.toMatchObject({ code: 403 })
    } finally {
      await app.service('roles').patch(everyone, { permissions: [] }, as(admin))
      await app.service('user-roles').patch(other.id, { roleIds: [otherRole] }, as(admin))
    }
  })

  it('reads the assignment of one user, for admins', async () => {
    await expect(app.service('user-roles').get(member.id, as(admin))).resolves.toEqual({ id: member.id, roleIds: member.roleIds })
    await expect(app.service('user-roles').get(member.id, as(operator))).rejects.toMatchObject({ code: 403 })
  })
})

describe('roles: the names of one\'s own', () => {
  it("lets everybody read the names of their own roles, and no other role", async () => {
    const page = await app.service('roles').find(as(member))
    expect(page.data.map((role) => role.key)).toEqual(['us01user'])
    expect(Object.keys(page.data[0]!).sort()).toEqual(['id', 'key', 'kind', 'name'])
    await expect(app.service('roles').get(await roleIdOf(app, 'admin'), as(member))).rejects.toMatchObject({ code: 404 })
  })
})

// ADR 0011, decided 2026-10-01: `everyone` is held without an assignment,
// edited like any role, never deleted; the fixed core stays whatever it
// grants.
describe('the everyone role', () => {
  it('cannot be assigned or deleted', async () => {
    const everyone = await roleIdOf(app, 'everyone')
    await expect(app.service('user-roles').patch(member.id, { roleIds: [everyone] }, as(admin))).rejects.toMatchObject({ code: 400 })
    await expect(app.service('roles').remove(everyone, as(admin))).rejects.toMatchObject({ code: 403 })
  })

  it('withdraws from everybody what it stops granting, but never the fixed core', async () => {
    const everyone = await roleIdOf(app, 'everyone')
    const ownAudit = () => app.service('audit-events').find({ ...as(member), query: { actorId: member.id } })
    await app.service('roles').patch(everyone, { permissions: ['audit-events.own', 'api-tokens.own'] }, as(admin))
    await expect(ownAudit()).resolves.toBeDefined()
    await expect(app.service('api-tokens').find(as(member))).resolves.toBeDefined()

    await app.service('roles').patch(everyone, { permissions: [] }, as(admin))
    try {
      expect((await app.service('users').get(member.id, as(member))).permissions?.sort()).toEqual(['documents.own', 'roles.own-names'])
      await expect(ownAudit()).rejects.toMatchObject({ code: 403 })
      await expect(app.service('api-tokens').find(as(member))).rejects.toMatchObject({ code: 403 })
      // The fixed core: the own record and the own export's list.
      await expect(app.service('users').get(member.id, as(member))).resolves.toMatchObject({ id: member.id })
      await expect(app.service('data-exports').find({ ...as(member), query: { requestedBy: member.id } })).resolves.toBeDefined()

      // Another role can give it back.
      const own = await roleIdOf(app, 'us01user')
      await app.service('roles').patch(own, { permissions: ['documents.own', 'roles.own-names', 'audit-events.own'] }, as(admin))
      await expect(ownAudit()).resolves.toBeDefined()
      await app.service('roles').patch(own, { permissions: ['documents.own', 'roles.own-names'] }, as(admin))
    } finally {
      await app.service('roles').patch(everyone, { permissions: [] }, as(admin))
    }
  })
})
