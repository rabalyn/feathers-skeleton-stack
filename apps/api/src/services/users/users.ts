import { hooks as schemaHooks } from '@feathersjs/schema'
import { KnexService } from '@feathersjs/knex'
import type { Application } from '../../app.js'
import { PAGINATE } from '../../paginate.js'
import {
  userDataResolver,
  userDataValidator,
  userExternalResolver,
  userPatchResolver,
  userPatchValidator,
  userQueryResolver,
  userQueryValidator,
  userResolver,
  type User,
  type UserData,
  type UserPatch,
  type UserQuery
} from './users.schema.js'
import type { NextFunction, Params } from '@feathersjs/feathers'
import { recordAudit } from '../../audit.js'
import { endUserConnections, publishTo, roleChannel, userChannel } from '../../channels.js'
import type { HookContext } from '../../declarations.js'

export type UserParams = Params<UserQuery>

export class UserService extends KnexService<User, UserData, UserParams, UserPatch> {}

export const USERS_PATH = 'users'
// create and remove are internal only: provisioning happens on login, and
// erasure is its own operation (ADR 0013).
export const USER_EXTERNAL_METHODS = ['find', 'get', 'patch'] as const

// Role changes and enabling or disabling an account are administrative
// actions and audited (ADR 0018). Internal patches are not user actions.
const auditPatch = async (context: HookContext<UserService>) => {
  if (!context.params.provider) return
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
      patch: [endConnectionsOnAccessChange]
    },
    before: {
      all: [schemaHooks.validateQuery(userQueryValidator), schemaHooks.resolveQuery(userQueryResolver)],
      create: [schemaHooks.validateData(userDataValidator), schemaHooks.resolveData(userDataResolver)],
      patch: [schemaHooks.validateData(userPatchValidator), schemaHooks.resolveData(userPatchResolver)]
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
