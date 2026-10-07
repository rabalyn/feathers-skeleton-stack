import type { ProductDirectory } from '../directory.js'

// What the product reads from the directory beyond the account's own fields
// (ADR 0008, 0009, 0035): the names of further LDAP attributes, and what it
// does with their values where accountFor() makes an account and at every
// login. See ProductDirectory in ../directory.js.
export const PRODUCT_DIRECTORY: ProductDirectory = {
  attributes: [],
  apply: async () => {}
}
