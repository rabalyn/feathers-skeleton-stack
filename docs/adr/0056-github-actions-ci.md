# 0056: GitHub Actions CI building the deployment Containerfiles and testing against an ephemeral stack

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › CI, Recommended CI and browser testing](../technical-architecture.md#ci)
- Related: [0030](0030-frontend-static-image.md), [0037](0037-compose-and-quadlet-definitions.md), [0038](0038-host-built-images-no-registry.md), [0042](0042-migration-and-rollback-policy.md), [0052](0052-restore-drills.md), [0057](0057-test-layers-and-isolation.md), [0058](0058-playwright-e2e.md)

## Context

Automated checks must run in an environment close to deployment and catch packaging and routing mistakes before release.

## Decision

Use GitHub Actions as the initial CI provider. Keep the workflow small: install with the frozen pnpm lockfile, lint and type-check, run unit and integration tests, build images, and run the end-to-end job.

CI builds the API, web, and Nginx images and runs checks against an ephemeral PostgreSQL and PgBouncer stack. At minimum:

- backend unit and service tests;
- frontend unit/component tests;
- linting and type checking;
- database migration tests against PostgreSQL;
- an integration or smoke test through Nginx using the built API and web artifacts;
- a WebSocket upgrade check through Nginx.

CI uses the same API and frontend Containerfiles as deployment. The test-only Nginx image uses its own Containerfile and configuration.

## Consequences

- Missing files, wrong runtime configuration, and routing errors show up before release.
- CI time grows with image builds and the E2E stack.

## ToDos

- ToDo: [Contradiction] The CI stack is "PostgreSQL and PgBouncer", but E2E login needs Valkey (authentication fails closed, ADR 0025), and upload/export flows need S3.
- ToDo: [Missing] Checks required by other decisions but absent from the list: backup-role creation, full dump, and restore test (ADR 0015, 0052); expand-and-contract compatibility (ADR 0042); `/health` and `/metrics` not reachable through Nginx (ADR 0054).
- ToDo: [Clarify] GitHub Actions `services:` containers (Docker on the runner) or rootless Podman with `compose.yaml`? The architecture mentions both, and ADR 0036 targets rootless Podman for CI.
- ToDo: [Missing] Triggers and gates: pull requests, `main`, release tags, required status checks, and a release workflow that produces the GitHub release manifest (ADR 0038).
- ToDo: [Clarify] Build caching strategy and CI runtime budget.
- ToDo: [Missing] Dependency and image vulnerability scanning (ADR 0068).
