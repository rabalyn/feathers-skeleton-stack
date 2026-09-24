# 0003: PostgreSQL as system of record, Knex as query builder, no ORM

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0011, 0012, 0042
- Related: [0004](0004-pgbouncer-pools.md), [0005](0005-typebox-schema-boundary.md), [0015](0015-testing-vitest-playwright.md)

## Context

The application needs a relational system of record and a data access layer that stays predictable as queries get complicated. ORMs tend to work well until a query needs something the abstraction does not express, at which point the escape hatch is usually worse than having written SQL from the start.

## Decision

- **PostgreSQL 18** in every environment, same major version everywhere. 18 rather than 17 so the project does not start on an already-aging major; supported into 2030.
- **Knex** as the query builder. Feathers services use `@feathersjs/knex`. No ORM, no entity mapping layer, no lazy-loaded relations.
- Queries that Feathers' adapter cannot express are written as explicit Knex query builder calls in the service implementation. Raw SQL strings are permitted only with bound parameters, never string concatenation.
- **The schema is defined and enforced at the application layer** using Feathers' built-in schema utilities (`@feathersjs/schema` with TypeBox, see [0005](0005-typebox-schema-boundary.md)). The database keeps the constraints that protect integrity regardless of application state — primary keys, foreign keys, unique indexes, not-null, check constraints — but the authoritative description of a resource's shape lives in the application schema.
- **Migrations** are Knex migrations, committed with the code that needs them, run by the one-shot `migrate` job during deployment. Never at API startup.
- The `migrate` job connects **directly to PostgreSQL**, bypassing PgBouncer, because schema work needs session-level features (`lock_timeout`, `CREATE INDEX CONCURRENTLY`, advisory locks).
- Migration style is expand-and-contract: add the new shape, deploy code tolerant of both, backfill, remove the old shape in a later release. Rollback rolls back code, not schema.
- Knex runs each migration in a transaction. A migration that cannot (`CREATE INDEX CONCURRENTLY` and similar) opts out with Knex's per-migration `export const config = { transaction: false }`, in the same directory and ordering as every other migration. Such a migration contains exactly one statement and is written to be re-runnable (`IF NOT EXISTS`, dropping an invalid index first), because a failure part-way leaves partial state that no transaction rolls back.

## Consequences

- SQL stays visible and debuggable; the cost is writing joins by hand rather than getting them from relation metadata.
- Application-layer schema means validation and the typed contract come from one definition, but drift between that definition and the database is possible and is caught only by integration tests against real PostgreSQL.
- Breaking schema changes take at least two releases.
