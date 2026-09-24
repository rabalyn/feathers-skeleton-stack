// Browser-safe client entry point (ADR 0007). It must never import Knex, pg,
// the SAML library, resolvers or hooks, directly or transitively; the
// dependency boundary lint rule enforces this once linting is set up.
export type { ServiceTypes } from './app.js'
