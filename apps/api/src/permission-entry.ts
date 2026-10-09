import type { AbilityBuilder, MongoAbility } from '@casl/ability'

// What a permission catalogue entry is (ADR 0011), apart from abilities.ts so
// that the product's catalogue (product/permissions.ts, ADR 0035) can build
// its entries without importing the module that imports it. Browser-safe
// like abilities.ts: nothing but @casl/ability, and that for types only.

export type AppAbility = MongoAbility

// Who an ability is for: the account, and the permission keys its roles add
// up to (loaded per request, ADR 0010).
export interface AbilityUser {
  id: string
  permissions: readonly string[]
  // The roles themselves, whose names the account may always read.
  roleIds?: readonly string[]
}

export type Can = AbilityBuilder<AppAbility>['can']

export interface PermissionEntry {
  key: string
  // The permissions page shows the catalogue grouped by this; its label is
  // the web app's translation `permissions.groups.<group>`.
  group: string
  grant: (can: Can, user: AbilityUser) => void
  // The permissions without which this one is of no use in the application
  // (ADR 0037). Holding it includes them, transitively.
  requires: readonly string[]
}

// One catalogue entry, its key kept as a literal type. A key is stable once
// released: roles store it. The web app translates `permissions.keys.<key>`
// and `permissions.descriptions.<key>`, dots replaced by underscores. A
// product entry may require a skeleton key, never the other way round.
export const entry = <K extends string>(
  key: K,
  group: string,
  grant: PermissionEntry['grant'],
  options: { requires?: readonly string[] } = {}
): PermissionEntry & { key: K } => ({
  key,
  group,
  grant,
  requires: options.requires ?? []
})
