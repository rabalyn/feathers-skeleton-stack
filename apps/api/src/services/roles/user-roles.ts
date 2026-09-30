import { MethodNotAllowed } from '@feathersjs/errors'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Id, NullableId, Params } from '@feathersjs/feathers'
import { Type, getValidator, type Static } from '@feathersjs/typebox'
import type { Application } from '../../app.js'
import { publishNothing } from '../../channels.js'
import { dataValidator } from '../../validators.js'

// Role assignment (ADR 0011): `admin`'s alone, and its own service rather
// than a field of users.patch, which feathers-casl would refuse or drop by
// field before schema validation. The id is the user's; a patch carries the
// full list of their roles. The change is made by an internal users.patch,
// which audits it in its transaction, ends the user's connections and
// publishes the user record like any other change of it (ADR 0012).

export const USER_ROLES_PATH = 'user-roles'
export const USER_ROLE_EXTERNAL_METHODS = ['get', 'patch'] as const

export const userRolesSchema = Type.Object(
  {
    // The user's surrogate id.
    id: Type.String({ format: 'uuid' }),
    roleIds: Type.Array(Type.String({ format: 'uuid' }))
  },
  { $id: 'UserRoles', additionalProperties: false }
)
export type UserRoles = Static<typeof userRolesSchema>

export const userRolesPatchSchema = Type.Object(
  { roleIds: Type.Array(Type.String({ format: 'uuid' }), { uniqueItems: true, maxItems: 50 }) },
  { $id: 'UserRolesPatch', additionalProperties: false }
)
export type UserRolesPatch = Static<typeof userRolesPatchSchema>
const userRolesPatchValidator = getValidator(userRolesPatchSchema, dataValidator)

export class UserRoleService {
  constructor(private readonly app: Application) {}

  async get(id: Id, _params?: Params): Promise<UserRoles> {
    const user = await this.app.service('users').get(id)
    return { id: user.id, roleIds: user.roleIds }
  }

  // The caller is handed on as the actor of the audit event.
  async patch(id: NullableId, data: UserRolesPatch, params?: Params): Promise<UserRoles> {
    if (id === null) throw new MethodNotAllowed('Roles are assigned to one user at a time')
    const user = await this.app.service('users').patch(id, { roleIds: data.roleIds }, { user: params?.user })
    return { id: user.id, roleIds: user.roleIds }
  }
}

export const userRoles = (app: Application) => {
  app.use(USER_ROLES_PATH, new UserRoleService(app), { methods: [...USER_ROLE_EXTERNAL_METHODS] })
  app.service(USER_ROLES_PATH).hooks({
    before: { patch: [schemaHooks.validateData(userRolesPatchValidator)] }
  })
  // The users patch it makes publishes the change.
  app.service(USER_ROLES_PATH).publish(publishNothing)
}

declare module '../../app.js' {
  interface ServiceTypes {
    [USER_ROLES_PATH]: UserRoleService
  }
}
