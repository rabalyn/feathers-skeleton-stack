# 0037: A permission names the permissions it needs, and holding it includes them

- Status: Accepted
- Date: 2026-10-09
- Scope: Required (v1)
- Related: [0011](0011-casl-role-authorization.md), [0029](0029-api-tokens.md), [0031](0031-netbox-locations.md), [0035](0035-products-derived-from-the-skeleton.md), [0036](0036-implied-actions.md), [0038](0038-gates-cover-what-a-page-calls.md)

## Context

A permission's rules often cannot be used alone. In foocore-key, lending a key (`loans.lend`) happens on pages that need reading keys and loans; a cylinder's page needs `sites.read` and `locations.read` to name its building and room. Nothing records this: an admin composing a role finds out by a 403. And a product permission may not grant a skeleton subject itself, since the skeleton's own tests run in every product and expect only the skeleton's permission to grant it (`allBut('sites.read')` must read no site), so a product feature that needs a skeleton service depends on two grants made separately.

## Decision

Decided with the user on 2026-10-09.

- **A catalogue entry may name `requires`**: the permission keys without which its rules are of no use in the application. `entry(key, group, grant, { requires: [...] })`. A product entry may require a skeleton key; a skeleton entry never requires a product key.
- **Holding a permission includes what it requires**, transitively. `defineAbilitiesFor` grants the closure of the caller's permissions; roles store only what an admin chose, so withdrawing the dependent permission withdraws what came with it. The permission keys sent with the own user record ([0011](0011-casl-role-authorization.md)) are the closure, each included one marked with the permission that brought it.
- **The permissions page shows inclusion**: a permission included by another one in the role is ticked and locked, with "included by …", and can only be removed with it.
- **API tokens** ([0029](0029-api-tokens.md)) get the closure of their chosen permissions, bounded by their owner's closure as before. A permission an API token may never carry is never required by one that a token may carry; a unit test refuses it.
- **The catalogue is checked by a unit test**: every required key exists, no cycle, no skeleton entry requiring a product key, no token-grantable entry requiring a token-excluded one.
- **The tests' `allBut(...keys)` leaves out every permission whose closure contains one of the keys**, so "everything but `sites.read`" still means no site is read, and a product permission may require a skeleton one without breaking the skeleton's tests.
- The skeleton's own requirements as of this decision: `locations.read` requires `sites.read`, since a room is found within its building; `locations.create` requires `locations.read`.

## Consequences

- An admin composes roles from what people do, and what that needs comes with it; the 403 found by trying goes away for every declared need.
- A role may hold more than its stored rows show. The page shows it, the export of a role (its stored keys) does not.
- A requirement left undeclared is still found by trying; [0038](0038-gates-cover-what-a-page-calls.md)'s gate walk finds it before an admin does.
- Every product reviews its entries once and declares their needs, and keeps doing so for new ones.
