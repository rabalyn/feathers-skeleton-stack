# 0010: Use TypeScript strict mode with additional index-access checks

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0008](0008-feathersjs-v5-api.md), [0017](0017-shared-contracts-package.md), [0029](0029-vue-quasar-feathers-pinia.md)

## Context

TypeScript is used for application code, configuration, and shared contracts. Looser compiler settings would weaken the value of the shared typed contract between API and frontend.

## Decision

Enable TypeScript `strict` mode together with `noImplicitAny` and `noUncheckedIndexedAccess`.

## Consequences

- Indexed and record access must handle `undefined`, which adds some verbosity but catches real bugs.
- Generated or third-party code that isn't strict-clean may need isolation or type shims.

## ToDos

- ToDo: [Clarify] `noImplicitAny` is already enabled by `strict`, so listing it separately is redundant. Remove it or explain why it is listed.
- ToDo: [Clarify] Which packages the settings apply to (API, contracts, web with `vue-tsc`), and whether a shared base `tsconfig` lives in `packages/`.
- ToDo: [Clarify] Whether further flags are wanted (`exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`) or explicitly rejected.
- ToDo: [Clarify] "TypeScript for configuration": Feathers normally uses `node-config` JSON files. Say whether configuration files are meant to be TypeScript or only validated by typed schemas (ADR 0067).
