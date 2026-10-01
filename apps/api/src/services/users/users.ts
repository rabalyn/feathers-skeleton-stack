import { hooks as schemaHooks } from '@feathersjs/schema'
import { KnexService, type KnexAdapterParams } from '@feathersjs/knex'
import type { PaginationOptions } from '../../paginate.js'
import type { Application } from '../../app.js'
import { PAGINATE } from '../../paginate.js'
import {
  userDataResolver,
  userDataValidator,
  userExternalResolver,
  userInternalPatchValidator,
  userPatchResolver,
  userPatchValidator,
  userQueryResolver,
  userQueryValidator,
  userResolver,
  type User,
  type UserData,
  type UserInternalPatch,
  type UserPatch,
  type UserQuery
} from './users.schema.js'
import { BadRequest } from '@feathersjs/errors'
import type { Id, NextFunction, Paginated } from '@feathersjs/feathers'
import type { Knex } from 'knex'
import { recordAudit } from '../../audit.js'
import { endUserConnections, publishTo, subjectChannel, userChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { AVATAR_CONTENT_TYPES } from '../files/files.schema.js'
import { attachFile, releaseFile } from '../files/attachments.js'

export interface UserParams extends KnexAdapterParams<UserQuery> {
  // The `roleId` query field, taken out of the query by moveRoleFilter:
  // user_roles is not a column of users.
  roleId?: string
}

type Row = Omit<User, 'roleIds'> & { roleIds?: string[] }

// Every user record carries the ids of its roles (ADR 0011), in one query
// for a whole page.
const withRoleIds = async (knex: Knex, rows: Row[]): Promise<User[]> => {
  const ids = rows.map((row) => row.id)
  const assignments: { userId: string; roleId: string }[] = ids.length
    ? await knex('userRoles').whereIn('userId', ids).orderBy('roleId').select('userId', 'roleId')
    : []
  return rows.map((row) => ({
    ...row,
    roleIds: assignments.filter((assignment) => assignment.userId === row.id).map((assignment) => assignment.roleId)
  }))
}

export class UserService extends KnexService<User, UserData, UserParams, UserPatch | UserInternalPatch> {
  createQuery(params: UserParams = {}) {
    const builder = super.createQuery(params)
    if (params.roleId) {
      const roleId = params.roleId
      builder.whereExists((holders) => {
        holders.select(1).from('userRoles').whereRaw('user_roles.user_id = users.id').andWhere('userRoles.roleId', roleId)
      })
    }
    return builder
  }

  async _find(params?: UserParams & { paginate?: PaginationOptions }): Promise<Paginated<User>>
  async _find(params?: UserParams & { paginate: false }): Promise<User[]>
  async _find(params?: UserParams): Promise<Paginated<User> | User[]>
  async _find(params: UserParams = {}): Promise<Paginated<User> | User[]> {
    const result = (await super._find(params)) as Paginated<Row> | Row[]
    const knex = params.transaction?.trx ?? this.Model
    if (Array.isArray(result)) return withRoleIds(knex, result)
    return { ...result, data: await withRoleIds(knex, result.data) }
  }

  async _get(id: Id, params: UserParams = {}): Promise<User> {
    const [user] = await withRoleIds(params.transaction?.trx ?? this.Model, [await super._get(id, params)])
    return user as User
  }
}

export const USERS_PATH = 'users'
// create and remove are internal only: provisioning happens on login, and
// erasure is its own operation (ADR 0013).
export const USER_EXTERNAL_METHODS = ['find', 'get', 'patch'] as const

// Enabling or disabling an account is an administrative action and audited
// (ADR 0018); role assignment is audited by the user-roles service. Internal
// patches are not user actions.
const auditPatch = async (context: HookContext<UserService>) => {
  const data = context.data as UserPatch
  if (!context.params.provider || data.enabled === undefined) return
  await recordAudit(context.app.get('knex'), {
    actorId: context.params.user?.id ?? null,
    action: 'users.patch',
    resourceType: USERS_PATH,
    resourceId: String(context.id),
    detail: { enabled: data.enabled }
  })
}

const sameRoles = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((id, index) => id === [...b].sort()[index])

// Changed roles or account state end the user's sockets, so none of them
// keeps the rights it was authenticated with (ADR 0012). A patch that
// changes neither leaves them alone.
const endConnectionsOnAccessChange = async (context: HookContext<UserService>, next: NextFunction) => {
  const data = context.data as UserInternalPatch | undefined
  if (context.id === null || context.id === undefined || (data?.roleIds === undefined && data?.enabled === undefined)) {
    await next()
    return
  }
  const before = await context.service._get(context.id)
  await next()
  const after = context.result as User
  if (!sameRoles(after.roleIds, before.roleIds) || after.enabled !== before.enabled) endUserConnections(context.app, after.id)
}

// Roles are rows of user_roles, written in the transaction of the patch that
// carries them, with their audit event; the actor is the caller the
// user-roles service hands on. The break-glass account keeps `admin`, so the
// application always has an administrator (ADR 0011).
const withRoles = async (context: HookContext<UserService>, next: NextFunction) => {
  const data = context.data as UserInternalPatch | undefined
  if (data?.roleIds === undefined || context.id === null || context.id === undefined) {
    await next()
    return
  }
  const userId = String(context.id)
  const roleIds = [...new Set(data.roleIds)]
  const { roleIds: _, ...rest } = data
  context.data = rest as typeof context.data
  await context.app.get('knex').transaction(async (trx) => {
    const roles: { id: string; kind: string }[] = roleIds.length ? await trx('roles').whereIn('id', roleIds).select('id', 'kind') : []
    if (roles.length !== roleIds.length) throw new BadRequest('Unknown role')
    // Everyone holds it already, without an assignment (ADR 0011).
    if (roles.some((role) => role.kind === 'everyone')) throw new BadRequest('The everyone role is not assigned')
    const user: { authSource: string } | undefined = await trx('users').where({ id: userId }).first('authSource')
    if (user?.authSource === 'local' && !roles.some((role) => role.kind === 'admin')) {
      throw new BadRequest('The break-glass account keeps the admin role')
    }
    const before: string[] = (await trx('userRoles').where({ userId }).select('roleId')).map((row: { roleId: string }) => row.roleId)
    const added = roleIds.filter((roleId) => !before.includes(roleId))
    const removed = before.filter((roleId) => !roleIds.includes(roleId))
    if (added.length || removed.length) {
      await recordAudit(trx, {
        actorId: context.params.user?.id ?? null,
        action: 'users.roles',
        resourceType: USERS_PATH,
        resourceId: userId,
        detail: { added, removed }
      })
    }
    await trx('userRoles').where({ userId }).whereNotIn('roleId', roleIds).delete()
    if (roleIds.length) {
      await trx('userRoles')
        .insert(roleIds.map((roleId) => ({ userId, roleId })))
        .onConflict(['userId', 'roleId'])
        .ignore()
    }
    context.params = { ...context.params, transaction: { trx } } as typeof context.params
    await next()
  })
}

// `roleId` filters by a join, not a column.
const moveRoleFilter = async (context: HookContext<UserService>) => {
  const query = context.params.query
  if (query?.roleId === undefined) return
  const { roleId, ...rest } = query
  context.params = { ...context.params, query: rest, roleId }
}

// External patches carry the account state only; the avatar, the locale and
// the roles arrive from their own services as internal patches.
const validateExternalPatch = schemaHooks.validateData(userPatchValidator)
const validateInternalPatch = schemaHooks.validateData(userInternalPatchValidator)
const validatePatch = async (context: HookContext<UserService>, next: NextFunction) => {
  await (context.params.provider ? validateExternalPatch : validateInternalPatch)(context, next)
}

// A new avatar is attached, and the one it replaces released, in the same
// transaction as the change (ADR 0020). The file must belong to the user
// whose avatar it becomes.
const withAvatar = async (context: HookContext<UserService>, next: NextFunction) => {
  const data = context.data as UserInternalPatch | undefined
  if (data?.avatarFileId === undefined || context.id === null || context.id === undefined) {
    await next()
    return
  }
  const before = await context.service._get(context.id)
  await context.app.get('knex').transaction(async (trx) => {
    if (data.avatarFileId && data.avatarFileId !== before.avatarFileId) {
      await attachFile(trx, data.avatarFileId, { ownerId: String(context.id), allowedTypes: AVATAR_CONTENT_TYPES })
    }
    context.params = { ...context.params, transaction: { trx } } as typeof context.params
    await next()
    if (before.avatarFileId && before.avatarFileId !== data.avatarFileId) await releaseFile(trx, before.avatarFileId)
  })
}

export const users = (app: Application) => {
  app.use(
    USERS_PATH,
    new UserService({
      Model: app.get('knex'),
      name: 'users',
      id: 'id',
      paginate: PAGINATE
    }),
    { methods: [...USER_EXTERNAL_METHODS] }
  )

  app.service(USERS_PATH).hooks({
    around: {
      all: [schemaHooks.resolveExternal(userExternalResolver), schemaHooks.resolveResult(userResolver)],
      // Validated before an avatar is attached.
      patch: [
        endConnectionsOnAccessChange,
        validatePatch,
        schemaHooks.resolveData(userPatchResolver),
        withRoles,
        withAvatar
      ]
    },
    before: {
      all: [schemaHooks.validateQuery(userQueryValidator), schemaHooks.resolveQuery(userQueryResolver), moveRoleFilter],
      create: [schemaHooks.validateData(userDataValidator), schemaHooks.resolveData(userDataResolver)]
    },
    after: {
      patch: [auditPatch]
    }
  })

  // A user record concerns its owner, and everyone who may read all users.
  app.service(USERS_PATH).publish(
    publishTo(app, (user) => [userChannel(String(user.id)), subjectChannel(USERS_PATH)])
  )
}

declare module '../../app.js' {
  interface ServiceTypes {
    [USERS_PATH]: UserService
  }
}
