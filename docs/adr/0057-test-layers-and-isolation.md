# 0057: Split tests into unit, integration, and end-to-end layers with isolated data

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Testing and Quality Gates](../technical-architecture.md#testing-and-quality-gates)
- Related: [0014](0014-pgbouncer-session-pooling.md), [0056](0056-github-actions-ci.md), [0058](0058-playwright-e2e.md)

## Context

Fast feedback needs cheap tests. Confidence needs tests against real infrastructure. Shared test state makes both unreliable.

## Decision

Split tests by feedback speed:

- unit tests for services, hooks, validators, stores, and components;
- integration tests for Feathers services against real PostgreSQL;
- end-to-end smoke tests against the built web and API containers.

Tests never depend on a developer's local database. CI creates its own database and cleans it up after the run. Test data is isolated per run.

## Consequences

- Database behaviour is tested against real PostgreSQL, not mocks.
- Integration tests need container infrastructure locally and in CI.

## ToDos

- ToDo: [Missing] Test runners: Vitest or Mocha (the Feathers generator's default) for the API; Vitest with Vue Test Utils for the web app?
- ToDo: [Missing] Lint and format tooling (ESLint and Prettier, or Biome), although linting is a CI gate.
- ToDo: [Clarify] "Isolated per run": is isolation per worker also required for parallel integration tests (template databases, schema per worker, transaction rollback)?
- ToDo: [Clarify] Do integration tests connect through PgBouncer (production-like) or directly to PostgreSQL?
- ToDo: [Clarify] "Should not depend on a developer's local database": local integration runs will still use the Compose `db` service. Clarify that this means no manually managed database state.
- ToDo: [Clarify] Coverage expectations, if any.
