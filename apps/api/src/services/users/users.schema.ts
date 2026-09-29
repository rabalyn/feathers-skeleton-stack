import { resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { LOCALES } from '../../locales.js'
import { loadPermissions } from '../../permissions.js'
import { dataValidator, queryValidator } from '../../validators.js'

// ADR 0005, 0009. Schemas and types may be imported by the client entry point
// as types only; resolvers below are server code.

const nullableString = Type.Union([Type.String(), Type.Null()])

export const userSchema = Type.Object(
  {
    // The resource address in the API (ADR 0009).
    id: Type.String({ format: 'uuid' }),
    // The identifier people see. Null for the break-glass account and after
    // erasure.
    tuId: nullableString,
    givenName: nullableString,
    surname: nullableString,
    email: nullableString,
    // The roles the person holds, any number (ADR 0011); assigned through
    // the user-roles service.
    roleIds: Type.Array(Type.String({ format: 'uuid' })),
    // The permission keys those roles add up to: on the caller's own record
    // and on internal reads only, so the browser can hide what it may not do.
    permissions: Type.Optional(Type.Array(Type.String())),
    enabled: Type.Boolean(),
    // An uploaded PNG, JPEG or WebP (ADR 0020); its bytes are at
    // file-contents/:avatarFileId.
    avatarFileId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    authSource: Type.Union([Type.Literal('saml'), Type.Literal('local')]),
    // The language the person last used in the web app; mail reaches them
    // in it (ADR 0027). Set through the locales service.
    locale: Type.Union(LOCALES.map((locale) => Type.Literal(locale))),
    // Set once the account is erased (ADR 0013): its directory fields and
    // avatar are gone, the account disabled for good.
    erasedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' })
  },
  { $id: 'User', additionalProperties: false }
)
export type User = Static<typeof userSchema>

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

export const userResolver = resolve<User, HookContext>({
  permissions: virtual(async (user, context) =>
    !context.params.provider || context.params.user?.id === user.id
      ? loadPermissions(context.app.get('knex'), user.id)
      : undefined
  ),
  erasedAt: virtual(async (user) => (user.erasedAt ? toIso(user.erasedAt) : null)),
  createdAt: virtual(async (user) => toIso(user.createdAt)),
  updatedAt: virtual(async (user) => toIso(user.updatedAt))
})

// The single place that redacts (ADR 0005). Users carry nothing secret: the
// break-glass password hash lives in local_credentials (ADR 0008). What a
// person may do is theirs to see: it leaves in a response to themselves, and
// never in an event, whose payload is this dispatch. An internal get is the
// authentication's own read of the account, whose result is the user's.
export const userExternalResolver = resolve<User, HookContext>({
  permissions: async (value, user, context) =>
    (context.params.provider ? context.params.user?.id === user.id : context.method === 'get') ? value : undefined
})

// Created only by just-in-time provisioning on login (ADR 0008), never by an
// external call: `create` is not an external method of this service.
export const userDataSchema = Type.Pick(userSchema, ['tuId', 'givenName', 'surname', 'email', 'authSource'], {
  $id: 'UserData',
  additionalProperties: false
})
export type UserData = Static<typeof userDataSchema>
export const userDataValidator = getValidator(userDataSchema, dataValidator)
export const userDataResolver = resolve<User, HookContext>({})

// What an external patch may change: enable/disable (ADR 0011). Directory
// fields are writable by nobody (ADR 0009). The avatar is set through the
// avatars service, the locale through the locales service and the roles
// through the user-roles service, whose internal patches may carry them.
export const userPatchSchema = Type.Partial(Type.Pick(userSchema, ['enabled']), {
  $id: 'UserPatch',
  additionalProperties: false,
  minProperties: 1
})
export type UserPatch = Static<typeof userPatchSchema>
export const userPatchValidator = getValidator(userPatchSchema, dataValidator)
export const userInternalPatchSchema = Type.Partial(Type.Pick(userSchema, ['enabled', 'avatarFileId', 'locale', 'roleIds']), {
  $id: 'UserInternalPatch',
  additionalProperties: false,
  minProperties: 1
})
export type UserInternalPatch = Static<typeof userInternalPatchSchema>
export const userInternalPatchValidator = getValidator(userInternalPatchSchema, dataValidator)
export const userPatchResolver = resolve<User, HookContext>({
  updatedAt: async () => new Date().toISOString()
})

export const userQueryProperties = Type.Pick(userSchema, [
  'id',
  'tuId',
  'givenName',
  'surname',
  'email',
  'enabled',
  'authSource',
  'erasedAt',
  'createdAt'
])
export const userQuerySchema = Type.Intersect(
  [
    querySyntax(userQueryProperties),
    // The holders of one role; not a column, so the service applies it.
    Type.Object({ roleId: Type.Optional(Type.String({ format: 'uuid' })) }, { additionalProperties: false })
  ],
  { additionalProperties: false }
)
export type UserQuery = Static<typeof userQuerySchema>
export const userQueryValidator = getValidator(userQuerySchema, queryValidator)
export const userQueryResolver = resolve<UserQuery, HookContext>({})
