# 0042: Expand-and-contract migrations; roll back code, not schema

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Migration and rollback policy](../technical-architecture.md#migration-and-rollback-policy)
- Related: [0012](0012-knex-adapter-and-migrations.md), [0039](0039-release-procedure-and-rollback.md), [0056](0056-github-actions-ci.md)

## Context

Schema changes are the riskiest part of a release. Automatic down-migrations rarely restore data safely.

## Decision

- Every schema change is a reviewed, versioned migration committed with the application code.
- Run migrations against a disposable PostgreSQL database in CI before release.
- Prefer expand-and-contract: add the new schema, deploy code that works with both forms, backfill, then remove the old schema in a later release.
- Keep production migrations small and transactional where PostgreSQL permits it. Avoid long locks during normal traffic.
- Don't rely on automatic `down` migrations as the primary production rollback. Rolling code back while keeping the newer schema is usually safer.
- For a failed migration: stop the release, check whether the migration committed, restore from the latest verified dump if data was changed incorrectly, and ship a forward fix when possible.

## Consequences

- Breaking schema changes take at least two releases.
- Application code must tolerate both the old and new schema during transitions.

## ToDos

- ToDo: [Contradiction] "Small and transactional" conflicts with lock-avoiding operations that can't run in a transaction, such as `CREATE INDEX CONCURRENTLY`. Define how such migrations are marked and handled (for example per-migration transaction opt-out).
- ToDo: [Clarify] Whether `down` migrations are written at all (useful in development and CI) or forbidden.
- ToDo: [Missing] CI doesn't check expand-and-contract compatibility, i.e. the previous API version against the new schema. The CI list only says "database migration tests" (ADR 0056).
- ToDo: [Clarify] `lock_timeout` and `statement_timeout` for migration sessions.
- ToDo: [Clarify] How pending "contract" steps are tracked so old schema actually gets removed later.
- ToDo: [Clarify] Whether CI migration tests run only against an empty database or also against representative data.
