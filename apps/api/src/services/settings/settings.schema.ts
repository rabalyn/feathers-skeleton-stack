import { resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import type { HookContext } from '../../declarations.js'
import { dataValidator, queryValidator } from '../../validators.js'

// ADR 0025. The value's shape depends on the key and is checked against the
// registry (settings/registry.ts) when written; here it is only JSON.

export const settingSchema = Type.Object(
  {
    // The key is the resource address: /api/settings/sessionIdleSeconds.
    key: Type.String(),
    value: Type.Unknown(),
    updatedAt: Type.String({ format: 'date-time' }),
    updatedBy: Type.Union([Type.String({ format: 'uuid' }), Type.Null()])
  },
  { $id: 'Setting', additionalProperties: false }
)
export type Setting = Static<typeof settingSchema>

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

export const settingResolver = resolve<Setting, HookContext>({
  updatedAt: virtual(async (setting) => toIso(setting.updatedAt))
})
export const settingExternalResolver = resolve<Setting, HookContext>({})

// A write replaces the value; who and when are set by the service.
export const settingPatchSchema = Type.Object(
  { value: Type.Unknown() },
  { $id: 'SettingPatch', additionalProperties: false }
)
export type SettingPatch = Static<typeof settingPatchSchema>
export const settingPatchValidator = getValidator(settingPatchSchema, dataValidator)

export const settingQuerySchema = Type.Intersect(
  [querySyntax(Type.Pick(settingSchema, ['key', 'updatedAt'])), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type SettingQuery = Static<typeof settingQuerySchema>
export const settingQueryValidator = getValidator(settingQuerySchema, queryValidator)
export const settingQueryResolver = resolve<SettingQuery, HookContext>({})
