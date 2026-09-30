import { subject } from '@casl/ability'
import { resolve, virtual } from '@feathersjs/schema'
import { Type, getValidator, querySyntax, type Static } from '@feathersjs/typebox'
import { ROLE_KINDS } from '../../abilities.js'
import type { HookContext } from '../../declarations.js'
import { LOCALES } from '../../locales.js'
import { dataValidator, queryValidator } from '../../validators.js'

// Roles (ADR 0011): a key, a name per locale and the catalogue permissions
// the role grants. Schemas and types may be imported by the client entry
// point as types only; resolvers below are server code.

export const ROLES_PATH = 'roles'

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string))

// Both locales required (ADR 0027).
export const roleNameSchema = Type.Object(
  Object.fromEntries(LOCALES.map((locale) => [locale, Type.String({ minLength: 1, maxLength: 80 })])) as Record<
    (typeof LOCALES)[number],
    ReturnType<typeof Type.String>
  >,
  { additionalProperties: false }
)

export const roleSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    // Stable, and what scripts and tests refer to a role by.
    key: Type.String({ pattern: '^[a-z][a-z0-9-]{1,39}$' }),
    kind: Type.Union(ROLE_KINDS.map((kind) => Type.Literal(kind))),
    name: roleNameSchema,
    // Catalogue keys; for `admin` the whole catalogue. Absent where the
    // caller may read the role's name only.
    permissions: Type.Optional(Type.Array(Type.String())),
    createdAt: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAt: Type.Optional(Type.String({ format: 'date-time' }))
  },
  { $id: 'Role', additionalProperties: false }
)
export type Role = Static<typeof roleSchema>

export const roleResolver = resolve<Role, HookContext>({
  createdAt: virtual(async (role) => toIso(role.createdAt)),
  updatedAt: virtual(async (role) => toIso(role.updatedAt))
})

// Field restrictions come from the caller's ability (ADR 0011): whoever
// reads user records sees role names, not what a role grants.
const readable =
  (field: 'permissions' | 'createdAt' | 'updatedAt') =>
  async <T>(value: T, role: Role, context: HookContext): Promise<T | undefined> => {
    const ability = context.params.ability
    if (ability && !ability.can('read', subject(ROLES_PATH, { ...role }), field)) return undefined
    return value
  }
export const roleExternalResolver = resolve<Role, HookContext>({
  permissions: readable('permissions'),
  createdAt: readable('createdAt'),
  updatedAt: readable('updatedAt')
})

// A custom role; `admin`, `operator` and `user` come from the migration.
export const roleDataSchema = Type.Object(
  {
    key: roleSchema.properties.key,
    name: roleNameSchema,
    permissions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }))
  },
  { $id: 'RoleData', additionalProperties: false }
)
export type RoleData = Static<typeof roleDataSchema>
export const roleDataValidator = getValidator(roleDataSchema, dataValidator)

// The name, or the full list of permissions, or both. The key and kind are
// fixed once created.
export const rolePatchSchema = Type.Object(
  {
    name: Type.Optional(roleNameSchema),
    permissions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { uniqueItems: true }))
  },
  { $id: 'RolePatch', additionalProperties: false, minProperties: 1 }
)
export type RolePatch = Static<typeof rolePatchSchema>
export const rolePatchValidator = getValidator(rolePatchSchema, dataValidator)

export const roleQueryProperties = Type.Pick(roleSchema, ['id', 'key', 'kind'])
export const roleQuerySchema = Type.Intersect(
  [querySyntax(roleQueryProperties), Type.Object({}, { additionalProperties: false })],
  { additionalProperties: false }
)
export type RoleQuery = Static<typeof roleQuerySchema>
export const roleQueryValidator = getValidator(roleQuerySchema, queryValidator)
