// Browser-safe client entry point (ADR 0007). It must never import Knex, pg,
// the SAML library, resolvers or hooks, directly or transitively; the
// dependency boundary lint rule enforces this once linting is set up.
// Types are imported with `import type`, which leaves nothing at runtime.
export type { ServiceTypes } from './app.js'
export type { User, UserPatch, UserQuery } from './services/users/users.schema.js'
export { ROLES, defineAbilitiesFor, type AbilityUser, type AppAbility, type Role } from './abilities.js'
export { PAGINATE } from './paginate.js'
