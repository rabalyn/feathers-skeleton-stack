import type { Knex } from 'knex'
import { ADMIN_PERMISSIONS, isPermissionKey } from './abilities.js'

// A user's permissions: the union of their roles' and the `everyone` role's,
// which every account holds without an assignment (ADR 0011). Loaded on
// every request rather than cached, so a changed role or assignment applies
// on the next one. Holding `admin` yields the whole catalogue and role
// management; a stored key the catalogue no longer declares is left out.
// `roleIds` are the assigned roles only.
export const loadAccess = async (
  knex: Knex | Knex.Transaction,
  userId: string
): Promise<{ roleIds: string[]; permissions: string[] }> => {
  const rows: { id: string; kind: string; permission: string | null; assigned: boolean }[] = await knex('roles')
    .leftJoin('userRoles', (join) => join.on('userRoles.roleId', 'roles.id').andOnVal('userRoles.userId', userId))
    .leftJoin('rolePermissions', 'rolePermissions.roleId', 'roles.id')
    .where((where) => {
      void where.whereNotNull('userRoles.userId').orWhere('roles.kind', 'everyone')
    })
    .select('roles.id', 'roles.kind', 'rolePermissions.permission', knex.raw('user_roles.user_id IS NOT NULL AS assigned'))
  const roleIds = [...new Set(rows.filter((row) => row.assigned).map((row) => row.id))].sort()
  if (rows.some((row) => row.kind === 'admin')) return { roleIds, permissions: [...ADMIN_PERMISSIONS] }
  const keys = new Set<string>()
  for (const { permission } of rows) if (permission && isPermissionKey(permission)) keys.add(permission)
  return { roleIds, permissions: [...keys].sort() }
}

export const loadPermissions = async (knex: Knex | Knex.Transaction, userId: string): Promise<string[]> =>
  (await loadAccess(knex, userId)).permissions

// The ids of everyone holding a role, e.g. to end their connections when the
// role's permissions change (ADR 0012).
export const holdersOf = async (knex: Knex | Knex.Transaction, roleId: string): Promise<string[]> =>
  (await knex('userRoles').where({ roleId }).select('userId')).map((row: { userId: string }) => row.userId)

// The role new accounts get on their first login (ADR 0011).
export const DEFAULT_ROLE_KEY = 'user'

export const assignDefaultRole = async (knex: Knex | Knex.Transaction, userId: string): Promise<void> => {
  await knex.raw(
    `INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE key = ? ON CONFLICT DO NOTHING`,
    [userId, DEFAULT_ROLE_KEY]
  )
}
