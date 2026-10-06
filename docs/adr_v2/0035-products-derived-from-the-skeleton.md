# 0035: Products are clones of the skeleton with its history, merging its tagged versions

- Status: Accepted
- Date: 2026-10-05
- Scope: Required (v1)
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0007](0007-typed-client-from-api.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0014](0014-frontend-quasar-vue.md), [0018](0018-owasp-security-baseline.md), [0019](0019-adr-convention.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md), [0027](0027-email-templates-and-sending.md), [0030](0030-service-generator.md), [0033](0033-branches-and-pull-requests.md)

## Context

This repository is the base that products are built on ([0001](0001-one-stack-every-environment.md)), and the first product, a rebuild of an existing application, is about to start. Each product needs a repository of its own, and each must keep receiving the skeleton's later work: security fixes, dependency updates, new mechanisms.

Three ways were weighed:

- **A long-lived branch per product in this repository.** It contradicts [0033](0033-branches-and-pull-requests.md), where every branch is a feature branch deleted once merged. Renovate, branch protection and the default branch know only `main`, so product branches would get no update pull requests. Product code would sit one merge away from `main`, against the rule that the skeleton holds no product logic. A product branch would carry its own `docs/adr_v2/`, quietly disagreeing with `main`'s. Permissions, issues, secrets and releases are per repository on GitHub, so products could not be separated.
- **A GitHub fork.** This repository is public and owned by a user account. GitHub forks a repository into another account only, so a fork would need an organisation, and a fork of a public repository stays public, which a university product generally may not be. A fork's pull requests also offer the skeleton as their base, so product changes are one click from being proposed upstream.
- **A copy as a new repository.** Without the history (GitHub's template repositories, or a copy of the files), the product shares no merge base with the skeleton, and every later skeleton change is ported by hand. With the history, it is a fork in everything but GitHub's bookkeeping, without its visibility rule.

## Decision

### The product repository

- **A product starts as a clone of this repository with its full history**, pushed to a new repository of its own, normally private. The remote named `skeleton` points here; `origin` is the product's own repository.
- No product branch is ever kept in this repository; [0033](0033-branches-and-pull-requests.md) holds unchanged.

### Skeleton versions

- **The skeleton tags versions on `main`**, `skeleton-vMAJOR.MINOR.PATCH`. MAJOR rises when a product has to change its own code to merge the version (a moved extension point, a contract migration it must follow); MINOR for new mechanisms; PATCH for fixes and dependency updates. The tag message lists what a product has to do.
- **A product merges tags, never `main` or a feature branch**: `git fetch skeleton --tags && git merge skeleton-vX.Y.Z`. Generated files in conflict are not resolved by hand but regenerated after the merge (`scripts/quadlet.sh`, `scripts/inventory.sh`). The merge is done when `scripts/ci.sh` passes.

### Upstream first

- **A change that is not specific to the product is made in the skeleton**, by a pull request here, and reaches the product with the next tag. This includes every change to the skeleton's own mechanisms and to `docs/adr_v2/`.
- A product may carry such a change ahead of the tag only when it cannot wait (a security fix in production), and only with the skeleton pull request opened at the same time; the merge of the tag then replaces it.
- Renovate stays on in every product, because [0018](0018-owasp-security-baseline.md) does not wait for a tag. Where a product's update and the skeleton's later one meet in a merge conflict, the newer version wins.

### What belongs to the product

- **Product code lives in product-owned files.** A product edits no skeleton file except `product.env` (the product identity below): it registers its code in the product module, the extension points below. Each further shared file a product has to edit is a place where the skeleton lacks an extension point, and is fixed in the skeleton.
- **A product's own ADRs live in `docs/adr_product/`**, numbered from 0001 with a README index of their own, in the format of [0019](0019-adr-convention.md). `docs/adr_v2/` stays the skeleton's and is changed upstream only. A product ADR may refine a skeleton ADR for that product but not contradict it; a product that needs a skeleton decision changed changes it here.
- A product rewrites `CLAUDE.md` and `README.md` for itself; in particular, its `CLAUDE.md` does not carry the skeleton's rule against product logic.

### Extension points

Decided 2026-10-06.

- **The product module.** The skeleton ships a set of product-owned files, empty, which its own registries import and append to their entries; a product fills them and leaves the skeleton's registries alone. Discovery by file name was rejected because the browser's client types cannot be derived from it without code generation; marker lines in the skeleton's files, because the skeleton and a product adding at the same marker conflict on every merge.

  | Product file | Extends | ADR |
  | --- | --- | --- |
  | `apps/api/src/product/services.ts` | the services, configured after the skeleton's | [0006](0006-feathersjs-typescript-api.md) |
  | `apps/api/src/product/client.ts` | the client's service types, re-exported by `src/client.ts` and bound by its dependency boundary | [0007](0007-typed-client-from-api.md) |
  | `apps/api/src/product/permissions.ts` | the permission catalogue, and what API tokens may not carry | [0011](0011-casl-role-authorization.md), [0029](0029-api-tokens.md) |
  | `apps/api/src/product/personal-data.ts` | the personal data registry | [0013](0013-gdpr-export-and-retention.md) |
  | `apps/api/src/product/files.ts` | the records that attach uploaded files, whose readers may download them (added 2026-10-06) | [0020](0020-object-storage-uploads.md) |
  | `apps/api/src/product/mail.ts` | the mail kinds | [0027](0027-email-templates-and-sending.md) |
  | `apps/api/src/product/settings.ts` | the runtime settings, which ones the api and the worker require, and cross-setting rules | [0025](0025-runtime-settings.md) |
  | `apps/api/src/product/preferences.ts` | the personal preference keys | [0014](0014-frontend-quasar-vue.md) |
  | `apps/api/src/product/jobs.ts` | job queues with their jobs and schedules, run by the worker beside the skeleton's | [0024](0024-background-jobs-bullmq.md) |
  | `apps/web/src/product/routes.ts` | the pages in the main layout, and their links in the navigation drawer, after the profile | [0014](0014-frontend-quasar-vue.md) |
  | `apps/web/src/i18n/product/{de,en}.json` | the message catalogues | [0014](0014-frontend-quasar-vue.md) |

  Everything else a product adds is a new file: its services, migrations, mail kinds, job handlers, pages and components. A product key, name or queue that equals one of the skeleton's is refused at start or by a test, never silently preferred.
- **A product's catalogues add keys and never replace one.** The skeleton's screens keep the skeleton's wording, and a skeleton key that changes meaning leaves no stale product text behind; a product that needs other wording on a skeleton screen changes it upstream. Overrides were rejected for that reason.
- **Erasure of a product's tables goes into `erase_user_product()`**, a database function that `erase_user()` calls first, in its transaction ([0013](0013-gdpr-export-and-retention.md)). The skeleton creates it as a no-op and never changes it again; a product's migrations replace it. Letting a product replace `erase_user()` itself was rejected: every later skeleton change to that function would have to be merged into the product's copy by hand.
- **`pnpm gen:service` registers where `product.env` says** ([0030](0030-service-generator.md)): in the skeleton's own files when `PRODUCT` is `feathers-skeleton`, in the product module otherwise. Both carry its marker lines.
- **In this repository the product module stays empty**, checked by a unit test in the CI image wherever `product.env` names the skeleton. The skeleton changes the module's files only in a MAJOR version; adding a file to it is a MINOR one.
- **A product grants as it needs, the seeded roles included.** It may grant its permissions to `everyone`, `user` or `operator`, rename them, or withdraw the skeleton's permissions from them, in its own migrations. So the skeleton's tests do not depend on what the seeded roles grant. Decided 2026-10-06 and built in slice 23:
  - **Integration tests** give their users roles of the test's own, with exactly the permissions each test needs (`makeUser` in `apps/api/test/support/roles.ts`), or the fixed `admin`. A denial is shown with everything else held where that is the point (`allBut`). `everyone` grants nothing in them: `createTestApp` empties it in the file's own database, without an audit event.
  - **The end-to-end suite** leaves `everyone` alone, since a product's specs share its database, and makes no negative assertion on a permission a product may plausibly grant to everyone. Its global setup, logged in through the API as the run's break-glass account, gives op01oper the role `e2e-operator` and us01user and us02othr `e2e-user`, which hold what the skeleton seeds `operator` and `user` with. A navigation assertion checks the skeleton's links in their order and ignores links it does not know.
  - **What the seeded roles grant by default** is checked only where `PRODUCT` names the skeleton, in `roles.test.ts`. Compose passes `PRODUCT` to the `test` container for that.
  - Checked once by hand, with a throwaway migration that renamed `operator` and `user`, withdrew `documents.own`, `documents.all` and everything of `operator`, gave `user` `queues.read` and `everyone` `sites.read`: both suites passed but that one skeleton-only check.

### The example content

Decided 2026-10-06. The skeleton's `documents` (service, page, the `documents.own` and `documents.all` permissions) and its campaign `documents.stale-reminder` ([0027](0027-email-templates-and-sending.md)) are its reference resource: the one ordinary owned record through which ownership rules, file attachments, channels, view-as, export and erasure, and campaigns are exercised and tested. They stay in the skeleton, and **a product inherits them unchanged**; it neither deletes nor edits them, so no merge conflicts there.

- A product that has no use for them **switches them off by grant**: a migration of its own withdraws `documents.own` and `documents.all` from the seeded roles (`DELETE FROM role_permissions WHERE permission IN ('documents.own', 'documents.all')`). Nobody but an admin then sees the page or its link, or may use the service.
- Admins still see them: the fixed `admin` role holds the whole catalogue ([0011](0011-casl-role-authorization.md)). An empty Documents page and the campaign kind on the mail pages remain for admins in every product; that is accepted, and keeps a working example in reach of whoever runs the product.
- The `documents` table stays in every product's database, empty unless used. Removing the example from the skeleton, or a product switch that unregisters it, were rejected: either would cost the mechanisms their end-to-end tests, in the skeleton or in the products.

### Product identity

- **Every product has its own identity**: a technical project name, a display name, and the pair of local ports its stack publishes. They are set in one file, `product.env` at the repository's root, and a product changes them there, nowhere else.
  - The project name names the Compose project, the local images, volumes, networks and containers, the local host names, and the local-only names derived from it (the OpenBao unseal volume, the CI image and its caches).
  - The display name is what people read: the browser title, the web app's product name, the sender name of e-mail ([0027](0027-email-templates-and-sending.md)), the labels of local keys and certificates.
  - The ports are the local HTTPS and HTTP ports, distinct per product on one machine.
  - The local fixtures stay skeleton-internal and are not renamed: the Keycloak realm `feathers`, the LDAP base `dc=feathers,dc=test`, the NetBox token key. Production replaces each of them by configuration.
- **Several products' local stacks run at the same time on one machine.** Locally, container names carry the project name (`<project>-api`), the published ports are the product's own, and the public host names sit under the product's own domain (`app.<project>.localhost`), so browsers keep each product's cookies apart. Inside a stack, services still reach each other by their service names. This is implemented with the change that introduces it, which records the details in [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md) and [0016](0016-nginx-and-tls-everywhere.md).
- **In production, each product runs as its own rootless Podman user or on its own host.** Rootless Podman keeps container names, images and volumes per user, so the generated Quadlet units keep their unprefixed names (`api`, `nginx`) in every product.

## Consequences

- Each product receives the skeleton's work as a merge, with a common history to resolve conflicts against. Conflicts land where products and the skeleton share a file; how often they occur measures what the skeleton is still missing in extension points.
- The product repository carries the skeleton's whole history. It is public here anyway, so this discloses nothing.
- Tags cost a release step in the skeleton, and a product's security depends partly on how promptly they are cut. Renovate in each product covers dependency pins in the meantime, at the price of the occasional pin conflict on merge.
- The `/docs` architecture page ([0019](0019-adr-convention.md#diagrams)) reads `docs/adr_v2/` only. A product's ADRs are not on it until the page reads `docs/adr_product/` as well.
- A product's own shared-file edits are tolerated, not prevented: nothing mechanical stops a product from editing a skeleton file. Review does, and the next merge's conflicts make such an edit visible.
- The registries read one more file each, and a registry's full contents are no longer in one place: the product's part is in `src/product/`. Each skeleton registry says so where it is defined.
- A product's navigation links all come after the profile, in the order the product lists them; placing one between two skeleton links needs a skeleton change. Each person may rearrange the drawer anyway.
- The runtime settings' web labels are checked by an api unit test, which reads the web catalogues, since the browser cannot import the registry; the api's test image carries those catalogues for it.
- Running stacks side by side costs memory: each stack is some forty containers.
