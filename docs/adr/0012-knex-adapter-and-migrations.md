# 0012: Use the Feathers Knex adapter and explicit, deployment-time migrations

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0014](0014-pgbouncer-session-pooling.md), [0015](0015-database-roles-and-connection-paths.md), [0039](0039-release-procedure-and-rollback.md), [0042](0042-migration-and-rollback-policy.md)

## Context

Feathers database services need an adapter for PostgreSQL, and schema changes must be versioned and applied predictably.

## Decision

Use the Knex adapter (`@feathersjs/knex`) for Feathers database services unless a later decision requires another adapter. Migrations are managed by the database layer and run explicitly during deployment, never implicitly at API startup.

## Consequences

- Services use Feathers' standard query syntax translated to SQL by Knex.
- Migration execution is a separate release step with its own credentials (ADR 0015) and failure handling (ADR 0039).

## ToDos

- ToDo: [Clarify] "Migrations managed by the database layer" doesn't name a tool. Knex migrations are implied by the adapter; confirm, including the migrations table and directory location.
- ToDo: [Missing] How migrations run in production: a command in the API image, a dedicated one-shot Quadlet unit, or a separate migration image; and which network it joins, since it needs a direct PostgreSQL connection (ADR 0015, 0035).
- ToDo: [Clarify] TypeScript migrations must be compiled into the production image or run through a loader. Decide which.
- ToDo: [Clarify] Whether `pnpm db:seed` uses Knex seeds, and how seeding is prevented against production (ADR 0053).
- ToDo: [Verify] ADR 0014 justifies session pooling with "Knex prepared statements", but Knex with `node-postgres` uses unnamed statements unless queries are explicitly named. Confirm which session-level features the application really needs.
- ToDo: [Clarify] Where `statement_timeout` is set (per role, per connection, per query). Business-metric queries require it (ADR 0062).
