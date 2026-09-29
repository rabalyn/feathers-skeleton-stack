import type { Application } from '../../src/app.js'
import type { User } from '../../src/services/users/users.schema.js'

// The roles the migration seeds (ADR 0011).
export type SeededRole = 'admin' | 'operator' | 'user'

export const roleIdOf = async (app: Application, key: string): Promise<string> => {
  const role: { id: string } | undefined = await app.get('knex')('roles').where({ key }).first('id')
  if (!role) throw new Error(`no role ${key}`)
  return role.id
}

// Gives a user exactly these roles, as an admin would, and returns the
// updated record.
export const grantRoles = async (app: Application, userId: string, keys: readonly string[]): Promise<User> =>
  app.service('users').patch(userId, { roleIds: await Promise.all(keys.map((key) => roleIdOf(app, key))) })

// Users made by users.create hold no role; a SAML login would have given
// them `user`.
export const makeUser = async (app: Application, tuId: string, role: SeededRole = 'user'): Promise<User> => {
  const created = await app.service('users').create({
    tuId,
    givenName: tuId,
    surname: 'Test',
    email: `${tuId}@example.org`,
    authSource: 'saml'
  })
  return grantRoles(app, created.id, [role])
}
