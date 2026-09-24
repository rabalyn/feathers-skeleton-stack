# 0011: Use PostgreSQL 17 as the system of record

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Goals, Backend](../technical-architecture.md#backend)
- Related: [0014](0014-pgbouncer-session-pooling.md), [0041](0041-postgresql-operations.md), [0042](0042-migration-and-rollback-policy.md)

## Context

The application needs a relational system of record for users, sessions, activity events, domain data, and references to stored objects.

## Decision

PostgreSQL is the system of record. Pin PostgreSQL 17 for local, CI, and production images. Apply minor updates regularly. Major-version upgrades are a documented dump-and-restore operation (ADR 0041).

## Consequences

- All environments exercise the same database major version.
- Major upgrades need a maintenance window and a tested restore.
- Business data that isn't binary object content belongs in PostgreSQL, not in S3 or Valkey.

## ToDos

- ToDo: [Verify] PostgreSQL 18 was released in September 2025 and PostgreSQL 19 is expected around now. PostgreSQL 17 is supported until November 2029, so it is viable, but confirm 17 is a deliberate choice rather than starting on a newer major.
- ToDo: [Clarify] Pin granularity (major tag, minor tag, or digest), and how one pin is shared by `compose.yaml`, GitHub Actions service containers, and Quadlet units.
- ToDo: [Clarify] "Apply minor updates regularly" has no cadence, owner, or test procedure.
- ToDo: [Clarify] Image source (official `postgres` image or other) and any required extensions (for example `citext` for case-insensitive email, see ADR 0022).
- ToDo: [Clarify] Consistency rules between PostgreSQL rows and S3 objects (orphaned objects, dangling references) are not assigned to any component (ADR 0044, 0049).
