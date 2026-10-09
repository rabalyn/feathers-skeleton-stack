import type { AdminApi } from './admin-api.js'
import { PRODUCT_WALK_FIXTURES } from './product/walk-fixtures.js'

// The records the gate walk creates before it opens a page whose route
// names them (`meta.walk.fixture`, ADR 0038): by name, a function that makes
// sure one exists, through the API as the admin, and may be called again.
// The skeleton's pages need none yet; a product's are in
// product/walk-fixtures.ts.
const SKELETON_WALK_FIXTURES: Record<string, (api: AdminApi) => Promise<void>> = {}

export const WALK_FIXTURES: Record<string, (api: AdminApi) => Promise<void>> = { ...SKELETON_WALK_FIXTURES, ...PRODUCT_WALK_FIXTURES }
for (const name of Object.keys(PRODUCT_WALK_FIXTURES)) {
  if (name in SKELETON_WALK_FIXTURES) throw new Error(`walk fixture ${name} is the skeleton's`)
}
