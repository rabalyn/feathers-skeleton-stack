import { Type, getValidator, type Static } from '@feathersjs/typebox'
import { hooks as schemaHooks } from '@feathersjs/schema'
import type { Params } from '@feathersjs/feathers'
import type { Application } from '../../app.js'
import { dataValidator } from '../../validators.js'
import { USERS_PATH } from './users.js'
import { userExternalResolver, type User, type UserInternalPatch, type UserPatch } from './users.schema.js'

// The caller's own avatar (ADR 0009, 0011, 0020): every role sets and clears
// it, on their own record only, since this service never takes a user id.
// It goes through an internal users patch, so the change is published like
// any other and the users rules stay exactly as they were.

export const AVATARS_PATH = 'avatars'
export const AVATAR_EXTERNAL_METHODS = ['create'] as const

export const avatarDataSchema = Type.Object(
  {
    // An uploaded PNG, JPEG or WebP of the caller's; null clears the avatar.
    fileId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()])
  },
  { $id: 'AvatarData', additionalProperties: false }
)
export type AvatarData = Static<typeof avatarDataSchema>
export const avatarDataValidator = getValidator(avatarDataSchema, dataValidator)

export class AvatarService {
  constructor(private readonly app: Application) {}

  async create(data: AvatarData, params?: Params): Promise<User> {
    const user = params?.user as { id: string }
    // Internal patches may carry the avatar (users.schema.ts); the typed,
    // external shape does not.
    const patch: UserInternalPatch = { avatarFileId: data.fileId }
    return this.app.service(USERS_PATH).patch(user.id, patch as UserPatch)
  }
}

export const avatars = (app: Application) => {
  app.use(AVATARS_PATH, new AvatarService(app), { methods: [...AVATAR_EXTERNAL_METHODS] })
  app.service(AVATARS_PATH).hooks({
    around: { create: [schemaHooks.resolveExternal(userExternalResolver)] },
    before: { create: [schemaHooks.validateData(avatarDataValidator)] }
  })
}

declare module '../../app.js' {
  interface ServiceTypes {
    [AVATARS_PATH]: AvatarService
  }
}
