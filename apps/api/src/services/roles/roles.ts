import { BadRequest, Conflict, Forbidden, MethodNotAllowed } from '@feathersjs/errors'
import { hooks as schemaHooks } from '@feathersjs/schema'
import { KnexService, type KnexAdapterOptions } from '@feathersjs/knex'
import type { Id, NullableId, Paginated, Params } from '@feathersjs/feathers'
import type { Knex } from 'knex'
import { PERMISSION_KEYS, isPermissionKey } from '../../abilities.js'
import type { Application } from '../../app.js'
import { recordAudit } from '../../audit.js'
import { endConnections, endUsersConnections, publishTo, subjectChannel } from '../../channels.js'
import { PAGINATE, type PaginationOptions } from '../../paginate.js'
import { holdersOf } from '../../permissions.js'
import {
  ROLES_PATH,
  roleDataValidator,
  roleExternalResolver,
  rolePatchValidator,
  roleQueryValidator,
  roleResolver,
  roleSchema,
  type Role,
  type RoleData,
  type RolePatch,
  type RoleQuery
} from './roles.schema.js'

// Roles (ADR 0011). Managing them is `admin`'s alone: creating, renaming,
// changing what they grant, deleting. `admin` itself is fixed; `everyone`,
// which every account holds without an assignment, `operator` and `user`
// are editable but stay. Every change and its audit event commit
// together, and a change to what a role grants ends the connections of
// everyone holding it (ADR 0012).

export { ROLES_PATH } from './roles.schema.js'
export const ROLE_EXTERNAL_METHODS = ['find', 'get', 'create', 'patch', 'remove'] as const

export type RoleParams = Params<RoleQuery>

type Row = Omit<Role, 'permissions'>

const unknownKeys = (keys: readonly string[]) => keys.filter((key) => !isPermissionKey(key))

const assertCatalogue = (keys: readonly string[] | undefined) => {
  const unknown = unknownKeys(keys ?? [])
  if (unknown.length) {
    throw new BadRequest('Unknown permission', { errors: unknown.map((key) => ({ key, message: 'not in the catalogue' })) })
  }
}

// What each role grants, in one query for a whole page. `admin` grants the
// whole catalogue, which is not stored; a stored key the catalogue no longer
// declares is left out.
const withPermissions = async (knex: Knex, rows: Row[]): Promise<Role[]> => {
  const ids = rows.filter((row) => row.kind !== 'admin').map((row) => row.id)
  const grants: { roleId: string; permission: string }[] = ids.length
    ? await knex('rolePermissions').whereIn('roleId', ids).orderBy('permission').select('roleId', 'permission')
    : []
  return rows.map((row) => ({
    ...row,
    permissions:
      row.kind === 'admin'
        ? [...PERMISSION_KEYS]
        : grants.filter((grant) => grant.roleId === row.id && isPermissionKey(grant.permission)).map((grant) => grant.permission)
  }))
}

export class RoleService extends KnexService<Role, RoleData, RoleParams, RolePatch> {
  constructor(
    options: KnexAdapterOptions,
    private readonly app: Application
  ) {
    super(options)
  }

  async _find(params?: RoleParams & { paginate?: PaginationOptions }): Promise<Paginated<Role>>
  async _find(params?: RoleParams & { paginate: false }): Promise<Role[]>
  async _find(params?: RoleParams): Promise<Paginated<Role> | Role[]>
  async _find(params: RoleParams = {}): Promise<Paginated<Role> | Role[]> {
    const result = (await super._find(params)) as Paginated<Row> | Row[]
    if (Array.isArray(result)) return withPermissions(this.Model, result)
    return { ...result, data: await withPermissions(this.Model, result.data) }
  }

  async _get(id: Id, params: RoleParams = {}): Promise<Role> {
    const [role] = await withPermissions(this.Model, [await super._get(id, params)])
    return role as Role
  }

  async create(data: RoleData, params?: RoleParams): Promise<Role>
  async create(data: RoleData[], params?: RoleParams): Promise<Role[]>
  async create(data: RoleData | RoleData[], params?: RoleParams): Promise<Role | Role[]> {
    if (Array.isArray(data)) throw new MethodNotAllowed('Roles are created one at a time')
    assertCatalogue(data.permissions)
    const actorId = params?.user?.id ?? null
    const id = await this.Model.transaction(async (trx) => {
      if (await trx('roles').where({ key: data.key }).first('id')) throw new Conflict(`The role key '${data.key}' is taken`)
      const [created]: { id: string }[] = await trx('roles')
        .insert({ key: data.key, kind: 'custom', name: data.name })
        .returning(['id'])
      if (!created) throw new Error('role insert returned nothing')
      const permissions = data.permissions ?? []
      if (permissions.length) await trx('rolePermissions').insert(permissions.map((permission) => ({ roleId: created.id, permission })))
      await recordAudit(trx, {
        actorId,
        action: 'roles.create',
        resourceType: ROLES_PATH,
        resourceId: created.id,
        detail: { key: data.key, name: data.name, permissions }
      })
      return created.id
    })
    return this._get(id)
  }

  async patch(id: Id, data: RolePatch, params?: RoleParams): Promise<Role>
  async patch(id: null, data: RolePatch, params?: RoleParams): Promise<Role[]>
  async patch(id: NullableId, data: RolePatch, params?: RoleParams): Promise<Role | Role[]>
  async patch(id: NullableId, data: RolePatch, params?: RoleParams): Promise<Role | Role[]> {
    if (id === null) throw new MethodNotAllowed('Roles are changed one at a time')
    assertCatalogue(data.permissions)
    const before = await this._get(id)
    if (before.kind === 'admin') throw new Forbidden('The admin role is fixed')
    const actorId = params?.user?.id ?? null
    const previous = before.permissions ?? []
    const added = data.permissions?.filter((key) => !previous.includes(key)) ?? []
    const removed = data.permissions ? previous.filter((key) => !data.permissions?.includes(key)) : []

    const holders = await this.Model.transaction(async (trx) => {
      await trx('roles')
        .where({ id: before.id })
        .update({ ...(data.name ? { name: data.name } : {}), updatedAt: trx.fn.now() })
      if (data.permissions) {
        await trx('rolePermissions').where({ roleId: before.id }).delete()
        if (data.permissions.length) {
          await trx('rolePermissions').insert(data.permissions.map((permission) => ({ roleId: before.id, permission })))
        }
      }
      await recordAudit(trx, {
        actorId,
        action: 'roles.patch',
        resourceType: ROLES_PATH,
        resourceId: before.id,
        detail: {
          ...(data.name ? { name: { from: before.name, to: data.name } } : {}),
          ...(data.permissions ? { added, removed } : {})
        }
      })
      return added.length || removed.length ? holdersOf(trx, before.id) : []
    })
    // Nobody keeps a socket authorized under what the role granted before;
    // for `everyone`, that is every signed-in connection but the caller's:
    // only `admin` changes roles, whose rights do not depend on `everyone`,
    // and ending it would drop this call's answer.
    if (before.kind === 'everyone' && (added.length || removed.length)) {
      endConnections(this.app, (connection) => connection.user !== undefined && connection !== params?.connection)
    }
    else if (holders.length) endUsersConnections(this.app, holders)
    return this._get(before.id)
  }

  async remove(id: Id, params?: RoleParams): Promise<Role>
  async remove(id: null, params?: RoleParams): Promise<Role[]>
  async remove(id: NullableId, params?: RoleParams): Promise<Role | Role[]>
  async remove(id: NullableId, params?: RoleParams): Promise<Role | Role[]> {
    if (id === null) throw new MethodNotAllowed('Roles are deleted one at a time')
    const role = await this._get(id)
    if (role.kind !== 'custom') throw new Forbidden(`The ${role.key} role cannot be deleted`)
    await this.Model.transaction(async (trx) => {
      // Locked, so an assignment cannot slip in between the check and the
      // delete; the foreign key would refuse it anyway.
      await trx('roles').where({ id: role.id }).forUpdate().first('id')
      const held: { userId: string } | undefined = await trx('userRoles').where({ roleId: role.id }).first('userId')
      if (held) throw new Conflict('The role is still assigned', { reason: 'assigned' })
      await trx('roles').where({ id: role.id }).delete()
      await recordAudit(trx, {
        actorId: params?.user?.id ?? null,
        action: 'roles.remove',
        resourceType: ROLES_PATH,
        resourceId: role.id,
        detail: { key: role.key, name: role.name, permissions: role.permissions ?? [] }
      })
    })
    return role
  }

}

export const roles = (app: Application) => {
  const options = {
    Model: app.get('knex'),
    name: 'roles',
    id: 'id',
    paginate: PAGINATE,
    // Every field: feathers-casl otherwise takes a rule without fields to
    // grant none, and the name-only rule would restrict admins too.
    casl: { availableFields: Object.keys(roleSchema.properties) }
  }
  app.use(ROLES_PATH, new RoleService(options as KnexAdapterOptions, app), { methods: [...ROLE_EXTERNAL_METHODS] })

  app.service(ROLES_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(roleExternalResolver), schemaHooks.resolveResult(roleResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(roleQueryValidator)],
      create: [schemaHooks.validateData(roleDataValidator)],
      patch: [schemaHooks.validateData(rolePatchValidator)]
    }
  })

  // To whoever reads roles, names only where that is all they read (ADR 0012).
  app.service(ROLES_PATH).publish(publishTo(app, () => [subjectChannel(ROLES_PATH)]))
}

declare module '../../app.js' {
  interface ServiceTypes {
    [ROLES_PATH]: RoleService
  }
}
