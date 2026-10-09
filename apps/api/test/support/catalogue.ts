import { PERMISSION_KEYS, closureOf, type PermissionKey } from '../../src/abilities.js'

// The whole catalogue but these, and but every permission that includes one
// of them (ADR 0037), for showing that nothing else grants what they do.
// Apart from roles.ts, which needs a database, so unit tests use it too.
export const allBut = (...keys: readonly PermissionKey[]): PermissionKey[] =>
  PERMISSION_KEYS.filter((key) => !closureOf(key).some((each) => (keys as readonly string[]).includes(each)))
