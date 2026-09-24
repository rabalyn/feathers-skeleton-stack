# 0009: Pin Node.js 22 LTS and pnpm 10 across all environments

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0016](0016-pnpm-workspace-monorepo.md), [0038](0038-host-built-images-no-registry.md)

## Context

Local development, CI, and production images should run the same runtime and package manager so that lockfile resolution and runtime behaviour don't drift between environments.

## Decision

Use Node.js 22 LTS for local development, CI, and production images. Pin pnpm 10 through the root `package.json` `packageManager` field so the whole workspace uses one package-manager version everywhere.

## Consequences

- One lockfile format and one resolution algorithm across all environments.
- Containerfiles, CI setup, and developer machines must all honour the pinned versions.
- Runtime upgrades become deliberate, reviewed changes.

## ToDos

- ToDo: [Verify] Node.js 22 moved to maintenance LTS in October 2025 and reaches end of life on 2027-04-30. Node.js 24 is the active LTS line. Decide whether to start on Node.js 24 to avoid a forced runtime upgrade shortly after the first production release.
- ToDo: [Clarify] Pin granularity is not defined: major only or an exact version? Say how it is enforced locally (`engines`, `.node-version`/`.nvmrc`, `engine-strict`) and whether base images are pinned by tag or digest.
- ToDo: [Verify] How `packageManager` is enforced. Corepack ships with Node.js 22/24 but is no longer bundled from Node.js 25 onwards; pnpm can also switch versions itself. Choose the mechanism, including inside Containerfile build stages.
- ToDo: [Verify] Confirm pnpm 10 is still the current supported major when the workspace is created.
