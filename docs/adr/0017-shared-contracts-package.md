# 0017: Share Feathers service contracts in `packages/contracts`; defer OpenAPI

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1); OpenAPI Deferred
- Source: [Technical architecture › Workspace and package management, Repository Layout](../technical-architecture.md#workspace-and-package-management)
- Related: [0013](0013-typebox-validation-boundary.md), [0016](0016-pnpm-workspace-monorepo.md), [0018](0018-repository-layout.md), [0063](0063-stats-endpoint.md)

## Context

The frontend should call the API with compile-time type safety. Two options are the Feathers typed client with shared TypeScript types, or a generated OpenAPI client.

## Decision

The initial API contract uses the Feathers typed client directly. Feathers service interfaces, TypeBox schemas, and inferred TypeScript types live in a shared `packages/contracts` package imported by both the API and the frontend. OpenAPI client generation is deferred until an external consumer or another language needs it.

## Consequences

- API changes that break the contract fail frontend type checks immediately.
- No language-neutral API description exists until OpenAPI is introduced.
- The contracts package must stay free of server-only code.

## ToDos

- ToDo: [Contradiction] The repository layout calls `packages/` "optional shared types", says the exact layout "is open until the first application scaffold", and says shared packages should only be introduced "when there is a real cross-application contract". The workspace section decides on `packages/contracts` now. Decide whether it is created in the initial scaffold.
- ToDo: [Contradiction] The layout text mentions "generated API types", while this decision uses inferred TypeBox types and defers generation.
- ToDo: [Clarify] The Feathers v5 generator puts the typed client inside the API package. Moving service interfaces to `packages/contracts` departs from the generator's structure. Confirm this is intended and document the pattern.
- ToDo: [Clarify] How contracts are consumed: TypeScript source through workspace linking, or built output. This affects Vite and API builds.
- ToDo: [Missing] A guard (lint rule or dependency check) that stops server-only dependencies (`knex`, resolvers, hooks) from entering `packages/contracts` and the frontend bundle.
- ToDo: [Clarify] Whether the "non-Grafana consumers" of `/stats` (ADR 0063) count as an external consumer that triggers OpenAPI.
