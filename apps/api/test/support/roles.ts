import { PERMISSION_KEYS, type PermissionKey } from '../../src/abilities.js'
import type { Application } from '../../src/app.js'
import type { User, UserData } from '../../src/services/users/users.schema.js'
import { db } from './worker-database.js'

// Tests own their roles (ADR 0035): a product may change what `everyone`,
// `operator` and `user` grant, so no test depends on it. A test's users hold
// roles of the test's own with exactly the permissions it needs, or the fixed
// `admin`; `everyone` grants nothing (createTestApp empties it). What the
// seeded roles grant by default is checked in roles.test.ts alone.

export const roleIdOf = async (app: Application, key: string): Promise<string> => {
  const role: { id: string } | undefined = await app.get('knex')('roles').where({ key }).first('id')
  if (!role) throw new Error(`no role ${key}`)
  return role.id
}

// Gives a user exactly these roles, as an admin would, and returns the
// updated record.
export const grantRoles = async (app: Application, userId: string, keys: readonly string[]): Promise<User> =>
  app.service('users').patch(userId, { roleIds: await Promise.all(keys.map((key) => roleIdOf(app, key))) })

// A custom role granting exactly these permissions; its name is its key.
export const makeRole = async (app: Application, key: string, permissions: readonly PermissionKey[]): Promise<string> => {
  const role = await app.service('roles').create({ key, name: { de: key, en: key }, permissions: [...permissions] })
  return role.id
}

// Withdraws everything `everyone` grants, in this file's own database
// (ADR 0015), without an audit event or a channel change.
export const emptyEveryone = async (): Promise<void> => {
  await db()('role_permissions')
    .whereIn('role_id', db()('roles').where({ kind: 'everyone' }).select('id'))
    .delete()
}

// The whole catalogue but these, for showing that nothing else grants what
// they do.
export const allBut = (...keys: readonly PermissionKey[]): PermissionKey[] => PERMISSION_KEYS.filter((key) => !keys.includes(key))

// The fixed `admin` role, or a role of the user's own, keyed by the TU-ID,
// that grants exactly these permissions; none makes no role.
export type Grant = 'admin' | readonly PermissionKey[]

// A user as a SAML login creates one, holding `grant`.
export const makeUser = async (
  app: Application,
  tuId: string,
  grant: Grant = [],
  fields: Partial<Pick<UserData, 'givenName' | 'surname' | 'email'>> = {}
): Promise<User> => {
  const created = await app.service('users').create({
    tuId,
    givenName: tuId,
    surname: 'Test',
    email: `${tuId}@example.org`,
    ...fields,
    authSource: 'saml'
  })
  if (grant === 'admin') return grantRoles(app, created.id, ['admin'])
  if (grant.length === 0) return created
  await makeRole(app, tuId, grant)
  return grantRoles(app, created.id, [tuId])
}
