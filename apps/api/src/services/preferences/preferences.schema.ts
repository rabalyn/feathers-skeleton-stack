import { resolve, virtual } from '@feathersjs/schema'
import { Type, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { PREFERENCE_KEYS } from '../../preferences/registry.js'
import { dataValidator, queryValidator, lazyValidator } from '../../validators.js'

// Preferences (ADR 0005, 0014): one row per person and key, the value
// checked against the key's schema in preferences/registry.ts. Schemas and
// types may be imported by the client entry point as types only; resolvers
// below are server code.

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

const preferenceKeySchema = Type.Union(PREFERENCE_KEYS.map((key) => Type.Literal(key)))

export const preferenceSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    // Always the caller (ADR 0011).
    userId: Type.String({ format: 'uuid' }),
    key: preferenceKeySchema,
    value: Type.Unknown(),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' })
  },
  { $id: 'Preference', additionalProperties: false }
)
export type Preference = Static<typeof preferenceSchema>

export const preferenceResolver = resolve<Preference, HookContext>({
  createdAt: virtual(async (record) => toIso(record.createdAt)),
  updatedAt: virtual(async (record) => toIso(record.updatedAt))
})

// Nothing to strip: the caller only ever sees their own rows.
export const preferenceExternalResolver = resolve<Preference, HookContext>({})

// A create sets the key's value, whether or not it had one: the service
// writes it as an upsert. The value is checked against the key's schema in
// a hook, since it depends on the key.
export const preferenceDataSchema = Type.Pick(preferenceSchema, ['key', 'value'], {
  $id: 'PreferenceData',
  additionalProperties: false
})
export type PreferenceData = Static<typeof preferenceDataSchema>
export const preferenceDataValidator = lazyValidator(preferenceDataSchema, dataValidator)
// Server-controlled fields are set here, never taken from the request.
export const preferenceDataResolver = resolve<Preference, HookContext>({
  userId: async (_value, _record, context) => (context.params.user as { id: string }).id
})

export const preferenceQueryProperties = Type.Pick(preferenceSchema, ['id', 'userId', 'key'])
export const preferenceQuerySchema = Type.Intersect(
  [querySyntax(preferenceQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type PreferenceQuery = Static<typeof preferenceQuerySchema>
export const preferenceQueryValidator = lazyValidator(preferenceQuerySchema, queryValidator)
export const preferenceQueryResolver = resolve<PreferenceQuery, HookContext>({})
