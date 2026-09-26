import { hooks as schemaHooks } from '@feathersjs/schema'
import { KnexService } from '@feathersjs/knex'
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
import type { NextFunction, Params } from '@feathersjs/feathers'
import { recordAudit } from '../../audit.js'
import { endUserConnections, publishTo, roleChannel, userChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'
import { AVATAR_CONTENT_TYPES } from '../files/files.schema.js'
import { attachFile, releaseFile } from '../files/attachments.js'

export type UserParams = Params<UserQuery>

export class UserService extends KnexService<User, UserData, UserParams, UserPatch> {}

export const USERS_PATH = 'users'
// create and remove are internal only: provisioning happens on login, and
// erasure is its own operation (ADR 0013).
export const USER_EXTERNAL_METHODS = ['find', 'get', 'patch'] as const

// Role changes and enabling or disabling an account are administrative
// actions and audited (ADR 0018). Internal patches are not user actions.
const auditPatch = async (context: HookContext<UserService>) => {
  const data = context.data as UserPatch
  if (!context.params.provider || (data.role === undefined && data.enabled === undefined)) return
  await recordAudit(context.app.get('knex'), {
    actorId: context.params.user?.id ?? null,
    action: 'users.patch',
    resourceType: USERS_PATH,
    resourceId: String(context.id),
    detail: Object.fromEntries(
      (['role', 'enabled'] as const)
        .filter((field) => (context.data as UserPatch)[field] !== undefined)
        .map((field) => [field, (context.data as UserPatch)[field]])
    )
  })
}

// A changed role or account state ends the user's sockets, so none of them
// keeps the rights it was authenticated with (ADR 0012). A patch that
// changes neither leaves them alone.
const endConnectionsOnAccessChange = async (context: HookContext<UserService>, next: NextFunction) => {
  const data = context.data as UserPatch | undefined
  if (context.id === null || context.id === undefined || (data?.role === undefined && data?.enabled === undefined)) {
    await next()
    return
  }
  const before = await context.service._get(context.id)
  await next()
  const after = context.result as User
  if (after.role !== before.role || after.enabled !== before.enabled) endUserConnections(context.app, after.id)
}

// External patches carry role and account state only; the avatar arrives
// from the avatars service as an internal patch.
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
        withAvatar
      ]
    },
    before: {
      all: [schemaHooks.validateQuery(userQueryValidator), schemaHooks.resolveQuery(userQueryResolver)],
      create: [schemaHooks.validateData(userDataValidator), schemaHooks.resolveData(userDataResolver)]
    },
    after: {
      patch: [auditPatch]
    }
  })

  // A user record concerns its owner, and everyone who may read all users.
  app.service(USERS_PATH).publish(
    publishTo(app, (user) => [userChannel(String(user.id)), roleChannel('admin'), roleChannel('operator')])
  )
}

declare module '../../app.js' {
  interface ServiceTypes {
    [USERS_PATH]: UserService
  }
}
