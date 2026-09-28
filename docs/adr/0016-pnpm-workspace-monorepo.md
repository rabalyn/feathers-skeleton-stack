# 0016: Use a pnpm workspace monorepo without a task orchestrator

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1); task orchestrator Deferred
- Source: [Technical architecture › Workspace and package management](../technical-architecture.md#workspace-and-package-management)
- Related: [0009](0009-node-and-pnpm-versions.md), [0017](0017-shared-contracts-package.md), [0018](0018-repository-layout.md)

## Context

The API and frontend are developed, tested, and released together and share typed contracts. They need linked local dependencies and one lockfile.

## Decision

Use a single repository with a pnpm workspace. Applications live under `apps/` (`apps/api`, `apps/web`); genuinely shared code lives under `packages/`. Start with plain pnpm workspace scripts. Add Turborepo, Nx, or a similar orchestrator only if build caching or task graphs become a demonstrated need.

## Consequences

- One lockfile and linked workspace dependencies without extra tooling.
- No build caching; CI and local runs rebuild everything, which is acceptable at this size.
- Containerfiles must handle workspace installs correctly.

## ToDos

- ToDo: [Clarify] Versioning: do all workspace packages share the single application version used in release tags (ADR 0038)? Are all packages `private`?
- ToDo: [Clarify] How Containerfiles install a single app from the workspace (for example `pnpm fetch` plus offline install, or `pnpm deploy` for a pruned production tree).
- ToDo: [Missing] Root script naming contract. Only `pnpm db:seed` is named; lint, typecheck, test, build, migrate, and e2e scripts should follow one convention used by CI.
- ToDo: [Clarify] Measurable criteria for "demonstrated need" before adding an orchestrator (for example CI duration).
