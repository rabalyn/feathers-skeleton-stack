import { resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { dataValidator, queryValidator } from '../../validators.js'

// API tokens (ADR 0029). Schemas and types may be imported by the client
// entry point as types only; resolvers below are server code.

export const API_TOKENS_PATH = 'api-tokens'

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

export const apiTokenSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    // The owner, whose rights bound the token's on every request.
    userId: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    // Catalogue keys chosen for the token.
    permissions: Type.Array(Type.String()),
    // The token's last four characters.
    hint: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
    expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    lastUsedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    // The token itself: in the result of `create` only, and never again.
    token: Type.Optional(Type.String())
  },
  { $id: 'ApiToken', additionalProperties: false }
)
export type ApiToken = Static<typeof apiTokenSchema>

export const apiTokenResolver = resolve<ApiToken, HookContext>({
  createdAt: virtual(async (token) => toIso(token.createdAt)),
  expiresAt: virtual(async (token) => (token.expiresAt ? toIso(token.expiresAt) : null)),
  lastUsedAt: virtual(async (token) => (token.lastUsedAt ? toIso(token.lastUsedAt) : null))
})

export const apiTokenDataSchema = Type.Object(
  {
    name: apiTokenSchema.properties.name,
    permissions: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, uniqueItems: true }),
    // Absent or null: the token lasts until it is revoked.
    expiresAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()]))
  },
  { $id: 'ApiTokenData', additionalProperties: false }
)
export type ApiTokenData = Static<typeof apiTokenDataSchema>
export const apiTokenDataValidator = getValidator(apiTokenDataSchema, dataValidator)

export const apiTokenQueryProperties = Type.Pick(apiTokenSchema, ['id', 'userId', 'name', 'createdAt', 'expiresAt', 'lastUsedAt'])
export const apiTokenQuerySchema = Type.Intersect(
  [querySyntax(apiTokenQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type ApiTokenQuery = Static<typeof apiTokenQuerySchema>
export const apiTokenQueryValidator = getValidator(apiTokenQuerySchema, queryValidator)
