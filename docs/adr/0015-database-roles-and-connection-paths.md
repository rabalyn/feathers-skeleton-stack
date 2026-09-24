# 0015: Separate database roles and connection paths for API, migrations, and backups

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › PgBouncer, PostgreSQL operations, Configuration and Security](../technical-architecture.md#postgresql-operations)
- Related: [0012](0012-knex-adapter-and-migrations.md), [0014](0014-pgbouncer-session-pooling.md), [0051](0051-backup-container-isolation.md), [0067](0067-secrets-and-configuration.md)

## Context

Different actors touch the database with very different privilege needs: the running API, schema migrations and admin tasks, and unattended backups.

## Decision

- The API uses least-privilege credentials and connects only through PgBouncer.
- Migrations and administrative tasks use a separate direct administrative connection to PostgreSQL, not the application pool.
- The backup container connects directly to PostgreSQL on the private database network, bypassing PgBouncer, with a dedicated read-only backup role separate from the API and migration credentials. That role gets explicit grants for application schemas, tables, sequences, and large objects.
- CI creates the backup role from scratch, runs a full dump, restores it into a clean database, and verifies representative contents.

## Consequences

- A compromised API credential cannot change the schema or read beyond its grants.
- Every migration that adds objects must keep the API and backup grants correct.
- Several credentials must be provisioned, stored, and rotated.

## ToDos

- ToDo: [Missing] A full role list: schema owner/migration role, API runtime role (DML only?), backup role, monitoring role (for a PostgreSQL exporter), and the role used by the bootstrap command (ADR 0059). Also state which role owns schema objects.
- ToDo: [Clarify] Whether `ALTER DEFAULT PRIVILEGES` is used so new tables and sequences are granted to the API and backup roles automatically. Otherwise every migration must repeat grants.
- ToDo: [Contradiction] A direct admin connection needs a network path from the migration runner to PostgreSQL, while ADR 0014 says application containers shouldn't need a direct database route. Decide which container runs migrations and on which network (ADR 0035).
- ToDo: [Clarify] The backup role could use the predefined `pg_read_all_data` role instead of hand-written grants. Also, are large objects used at all, given binary data lives in S3?
- ToDo: [Clarify] Who creates roles and their passwords in production: an init script, the bootstrap command, or a migration.
