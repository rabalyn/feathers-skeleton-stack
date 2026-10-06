import type { TSchema } from '@feathersjs/typebox'

// The product's personal preference keys (ADR 0014, 0035) and the schema of
// each value, merged into preferences/registry.ts. A key is stable once
// released, since rows store it.
export const PRODUCT_PREFERENCES = {} satisfies Record<string, TSchema>
