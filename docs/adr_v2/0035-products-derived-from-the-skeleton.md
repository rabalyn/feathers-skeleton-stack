# 0035: Products are clones of the skeleton with its history, merging its tagged versions

- Status: Accepted
- Date: 2026-10-05
- Scope: Required (v1)
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0018](0018-owasp-security-baseline.md), [0019](0019-adr-convention.md), [0027](0027-email-templates-and-sending.md), [0030](0030-service-generator.md), [0033](0033-branches-and-pull-requests.md)

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

- **Product code lives in product-owned files.** A product edits skeleton files only where the skeleton provides for it: today, the marker lines that `pnpm gen:service` writes at ([0030](0030-service-generator.md)) and the product identity below. Each further shared file a product has to edit is a place where the skeleton lacks an extension point, and is fixed in the skeleton.
- **A product's own ADRs live in `docs/adr_product/`**, numbered from 0001 with a README index of their own, in the format of [0019](0019-adr-convention.md). `docs/adr_v2/` stays the skeleton's and is changed upstream only. A product ADR may refine a skeleton ADR for that product but not contradict it; a product that needs a skeleton decision changed changes it here.
- A product rewrites `CLAUDE.md` and `README.md` for itself; in particular, its `CLAUDE.md` does not carry the skeleton's rule against product logic.

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
- Running stacks side by side costs memory: each stack is some forty containers.
