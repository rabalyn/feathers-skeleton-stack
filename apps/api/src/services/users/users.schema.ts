import { resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
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
    role: Type.Union([Type.Literal('admin'), Type.Literal('operator'), Type.Literal('user')]),
    enabled: Type.Boolean(),
    // An uploaded PNG, JPEG or WebP (ADR 0020); its bytes are at
    // file-contents/:avatarFileId.
    avatarFileId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    authSource: Type.Union([Type.Literal('saml'), Type.Literal('local')]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' })
  },
  { $id: 'User', additionalProperties: false }
)
export type User = Static<typeof userSchema>

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

export const userResolver = resolve<User, HookContext>({
  createdAt: virtual(async (user) => toIso(user.createdAt)),
  updatedAt: virtual(async (user) => toIso(user.updatedAt))
})

// The single place that redacts (ADR 0005). Users carry nothing secret: the
// break-glass password hash lives in local_credentials (ADR 0008).
export const userExternalResolver = resolve<User, HookContext>({})

// Created only by just-in-time provisioning on login (ADR 0008), never by an
// external call: `create` is not an external method of this service.
export const userDataSchema = Type.Pick(userSchema, ['tuId', 'givenName', 'surname', 'email', 'authSource'], {
  $id: 'UserData',
  additionalProperties: false
})
export type UserData = Static<typeof userDataSchema>
export const userDataValidator = getValidator(userDataSchema, dataValidator)
export const userDataResolver = resolve<User, HookContext>({})

// What an external patch may change: role assignment and enable/disable
// (ADR 0011). Directory fields are writable by nobody (ADR 0009). The avatar
// is set through the avatars service, whose internal patch may carry it.
export const userPatchSchema = Type.Partial(Type.Pick(userSchema, ['role', 'enabled']), {
  $id: 'UserPatch',
  additionalProperties: false,
  minProperties: 1
})
export type UserPatch = Static<typeof userPatchSchema>
export const userPatchValidator = getValidator(userPatchSchema, dataValidator)
export const userInternalPatchSchema = Type.Partial(Type.Pick(userSchema, ['role', 'enabled', 'avatarFileId']), {
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
  'role',
  'enabled',
  'authSource',
  'createdAt'
])
export const userQuerySchema = Type.Intersect(
  [querySyntax(userQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type UserQuery = Static<typeof userQuerySchema>
export const userQueryValidator = getValidator(userQuerySchema, queryValidator)
export const userQueryResolver = resolve<UserQuery, HookContext>({})
