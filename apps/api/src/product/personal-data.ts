import type { RegistryEntry } from '../gdpr/registry.js'

// The product's stores of personal data (ADR 0013, 0035), appended to the
// skeleton's registry in gdpr/registry.ts and checked against the schema like
// it: every column referencing users(id) is listed here or there. What
// erasure does to a product table goes into the database function
// erase_user_product(), which erase_user() calls first, in its transaction;
// a product migration replaces it, the skeleton never does. Like erase_user()
// it must be idempotent: erasing a person twice changes nothing.
export const PRODUCT_PERSONAL_DATA: readonly RegistryEntry[] = []
