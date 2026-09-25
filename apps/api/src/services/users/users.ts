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
import type { Params } from '@feathersjs/feathers'

export type UserParams = Params<UserQuery>

export class UserService extends KnexService<User, UserData, UserParams, UserPatch> {}

export const USERS_PATH = 'users'
// create and remove are internal only: provisioning happens on login, and
// erasure is its own operation (ADR 0013).
export const USER_EXTERNAL_METHODS = ['find', 'get', 'patch'] as const

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
      all: [schemaHooks.resolveExternal(userExternalResolver), schemaHooks.resolveResult(userResolver)]
    },
    before: {
      all: [schemaHooks.validateQuery(userQueryValidator), schemaHooks.resolveQuery(userQueryResolver)],
      create: [schemaHooks.validateData(userDataValidator), schemaHooks.resolveData(userDataResolver)],
      patch: [schemaHooks.validateData(userPatchValidator), schemaHooks.resolveData(userPatchResolver)]
    }
  })
}

declare module '../../app.js' {
  interface ServiceTypes {
    [USERS_PATH]: UserService
  }
}
