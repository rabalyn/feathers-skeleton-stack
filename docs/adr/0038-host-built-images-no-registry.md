# 0038: Build production images on the host from versioned release sources; no registry initially

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production); registry Deferred
- Source: [Technical architecture › Production orchestration](../technical-architecture.md#production-orchestration)
- Related: [0009](0009-node-and-pnpm-versions.md), [0030](0030-frontend-static-image.md), [0039](0039-release-procedure-and-rollback.md), [0056](0056-github-actions-ci.md)

## Context

A container registry adds an external dependency and credentials. With a single host, images can be built where they run.

## Decision

- CI doesn't publish images to a registry.
- The production host builds the API, web, and production service images from a versioned release source, using the pinned lockfile and the Containerfiles.
- Tag images with a semantic version such as `v1.2.3` plus the exact git SHA.
- Record both in a versioned GitHub release manifest containing the source commit, dependency lockfile checksum, build inputs, and resulting local image digests.
- The host keeps the previous image set for rollback.
- Revisit a registry when build time, host access, or multi-host deployment makes local production builds impractical.

## Consequences

- No registry to operate or pay for.
- Each release depends on a successful build on the production host.

## ToDos

- ToDo: [Contradiction] The images tested in CI aren't the images deployed, because the host rebuilds them. A different base-image pull or build input can change the contents, which weakens "tests in an environment close to deployment" and "immutable image tags". At minimum, pin base images by digest and use a frozen lockfile. Consider comparing CI and host digests.
- ToDo: [Clarify] The GitHub release manifest must contain digests produced on the host after the build. That needs either host-to-GitHub write credentials or a manual upload step, and the order of "create release" and "build" is unclear.
- ToDo: [Clarify] What "production service images" means: which of PostgreSQL, PgBouncer, Valkey, MinIO, backup, and observability images are built locally, and which are pulled upstream by pinned digest?
- ToDo: [Clarify] The production host needs outbound access to the npm registry and base-image registries at release time. Define the failure mode when they are unreachable.
- ToDo: [Clarify] Build CPU and memory compete with the running application and the monitoring budget (ADR 0064). Should builds run in a maintenance window?
- ToDo: [Clarify] Who assigns semantic versions and how.
- ToDo: [Clarify] Only the immediately previous image set is kept, so rolling back two releases is impossible. Confirm, and define pruning of older images.
- ToDo: [Contradiction] ADR 0030 runs lint and tests inside the web image build, which then runs on the production host.
