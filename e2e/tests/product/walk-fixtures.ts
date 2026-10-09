import type { AdminApi } from '../admin-api.js'

// The product's records for the gate walk (ADR 0038): by the name a route's
// `meta.walk.fixture` gives, a function that makes sure one such record
// exists, through the API as the admin, and may be called again. Appended
// to the skeleton's in walk-fixtures.ts (ADR 0035).
export const PRODUCT_WALK_FIXTURES: Record<string, (api: AdminApi) => Promise<void>> = {}
