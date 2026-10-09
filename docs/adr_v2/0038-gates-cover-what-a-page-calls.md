# 0038: A page and each of its sections are gated on everything they call, proven by a gate walk

- Status: Accepted
- Date: 2026-10-09
- Scope: Required (v1)
- Related: [0011](0011-casl-role-authorization.md), [0014](0014-frontend-quasar-vue.md), [0015](0015-testing-vitest-playwright.md), [0035](0035-products-derived-from-the-skeleton.md), [0036](0036-implied-actions.md), [0037](0037-permission-prerequisites.md)

## Context

A route names one requirement (`meta.requires`, or `requiresSome`, `requiresAny`), and the navigation shows the link when it is met. What the page then calls is not checked against it: in foocore-key the Ausgabe page opens under "read loans", and its key lookup calls `transponders.find`, which "read loans" does not imply; a key's panel loads its loans whichever permission opened the list. The person sees a failure notice, not a missing section. [0036](0036-implied-actions.md) and [0037](0037-permission-prerequisites.md) remove most such gaps at their source, but nothing proves a page's calls are covered.

## Decision

Decided with the user on 2026-10-09.

- **A route's gate lists everything the page needs**: `meta.requires` takes a list of `[action, subject]`, all of which must hold (the single pair stays valid). `requiresSome` and `requiresAny` keep their meaning. The navigation link is shown on the same gate.
- **A section shows only when the caller may make its calls**: every `client.service(...)` call a page makes outside its route gate sits behind a `can` or `canAll` check on the same action and subject, and the section that makes it is hidden, not left to fail. A missing permission is never answered by a failure notice the person can do nothing about.
- **The gate walk proves it**, a Playwright spec of the skeleton's that every product runs: for every route in the navigation and every catalogue permission whose closure ([0037](0037-permission-prerequisites.md)) passes the route's gate on its own, a user holding only that permission opens the page and, where it has a list, its first record's panel; no response may be a 401, 403 or 404 from a gate, and no failure notice may show. Routes and permissions come from the router and the catalogue, so a product's are walked too.
- A page that needs a record to show its panel names a fixture the walk creates first, through the api, as the admin.

### How the walk is built

Decided with the user on 2026-10-09, while building it.

- **The walk account holds `everyone` beside the walked permission**, as every account does: "only that permission" means a role of the walk's own holding that one permission. `everyone` is left alone, so the walk runs beside the other specs ([0035](0035-products-derived-from-the-skeleton.md)). The account, `wk01walk`, is the walk's alone (`containers/ldap/seed/walker.ldif`).
- **Routes and permissions are read off the running app.** The catalogue is the fixed admin's own record ([0011](0011-casl-role-authorization.md)); the routes a permission passes are the links the walk account's navigation shows while it holds it, which is the route's own gate. Every permission walks every link shown, the profile included, since a section a permission shows may fail on any page.
- **A route names what the walk does on its page** in `meta.walk`: `panel` to click the first record of the list the page marks with `data-walk="list"` (a table's first row or a list's first item), and `fixture`, the name of the record the walk creates first. The layout passes both to the page container (`data-walk-panel`, `data-walk-fixture`), where the walk reads them.
- **Fixtures** are functions by name in `e2e/tests/walk-fixtures.ts`, the skeleton's, and `e2e/tests/product/walk-fixtures.ts`, a product's ([0035](0035-products-derived-from-the-skeleton.md)): each makes sure one record exists, through the API as the run's break-glass admin, and may be called again.
- **A refused call** is an answer of the API's socket ([0012](0012-role-scoped-channels.md)) with code 401, 403 or 404, read off the websocket's frames; **a failure notice** is a negative notification. Each permission's problems are reported together, all permissions in one run.
- **The navigation shows a link on its route's gate**: a link names the route, the gate is read from the route's `meta`, and links carry no gate of their own.

## Consequences

- A role that passes a page's gate sees a working page; sections it may not use are absent.
- Every existing page is reviewed once and its sections gated; product pages included.
- The walk grows with routes times permissions; it runs in `scripts/ci.sh` with the other end-to-end specs and is sharded if it gets slow.
- A call made only after a click (a dialog) is outside the walk; its gate is checked by review.
