# 0013: Use TypeBox schemas and enforce validation and authorization at the service boundary

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0017](0017-shared-contracts-package.md), [0021](0021-casl-role-authorization.md), [0068](0068-api-security-baseline.md)

## Context

Requests arrive over REST and WebSocket and must be validated the same way on both transports. The frontend should share the same types.

## Decision

Use TypeBox for request, response, query, and data schemas, with TypeScript types derived from them where practical. API validation and authorization happen at the Feathers service boundary. Database constraints remain the final integrity boundary.

## Consequences

- One schema definition drives runtime validation and static types.
- Invariants that matter for integrity (uniqueness, foreign keys, not-null) must also exist as database constraints.
- Validation failures surface as Feathers errors that the frontend must handle.

## ToDos

- ToDo: [Clarify] "Generated TypeScript types where practical": TypeBox infers types with `Static<>` without code generation. Is any generation step intended (for example from the database schema), or does this just mean inference?
- ToDo: [Verify] `@feathersjs/typebox` depends on a specific `@sinclair/typebox` version, and TypeBox 1.x has since been published under a new package name. Pin one compatible pair and avoid mixing versions between API, contracts, and web.
- ToDo: [Clarify] Where Feathers resolvers (data, result, external, query) live. They contain server logic and must not end up in `packages/contracts` imported by the frontend (ADR 0017).
- ToDo: [Clarify] Validator configuration: query-string coercion, default `additionalProperties: false`, and formats such as `email`.
- ToDo: [Clarify] Which invariants are duplicated in TypeBox and PostgreSQL (for example case-insensitive email uniqueness).
- ToDo: [Clarify] Whether the validation error response shape is a stable contract for the frontend.
