# 0039: Release procedure of backup, migrate, validate, switch, with image-tag rollback

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › PostgreSQL operations, Production orchestration, Migration and rollback policy, Production](../technical-architecture.md#postgresql-operations)
- Related: [0012](0012-knex-adapter-and-migrations.md), [0038](0038-host-built-images-no-registry.md), [0042](0042-migration-and-rollback-policy.md), [0048](0048-postgresql-backup-restic-nfs.md), [0052](0052-restore-drills.md)

## Context

Releases change code and schema together on a single host. A failed release must be recoverable without guesswork.

## Decision

- Deployments use immutable image tags, a controlled update procedure, health checks, and a documented rollback to the previous image tag.
- Each production release: take a verified backup → run migrations over the direct administrative connection → validate readiness → only then start or switch to the new API image.
- Apply migrations as a controlled release step before enabling code that depends on them.
- A migration failure stops the release, followed by manual restore or a reviewed forward fix.
- Migrations must stay compatible with the currently running API during any transition window.
- Before each release, record the migration version, latest verified backup snapshot, application image version, and tested recovery procedure.

## Consequences

- Every release has a known restore point.
- Rollback is a code-only operation; the schema stays at the newer version (ADR 0042).

## ToDos

- ToDo: [Contradiction] Each release takes "a verified backup", but "a backup is not considered valid until" a full restore produces a usable database and object set, which only happens in the monthly drill (ADR 0052). Define what can realistically be verified per release (for example `restic check` plus `pg_restore --list`).
- ToDo: [Clarify] "Validate readiness" happens before the new API starts: readiness of what? The old API against the migrated schema? The database?
- ToDo: [Clarify] With one host and one API instance, does the old API keep running during migrations (needs compatibility, zero downtime) or stop (planned downtime)? Is zero downtime required at all? That decides what "transition window" means.
- ToDo: [Clarify] Whether web and API images switch together, and how cached SPA assets behave against a newer API.
- ToDo: [Missing] Rollback runbook: criteria, steps, who decides, and handling when migrations already ran.
- ToDo: [Clarify] Where the pre-release record is stored (the GitHub release manifest from ADR 0038?).
- ToDo: [Clarify] How releases are prevented from overlapping the 02:00 UTC backup window (ADR 0049).
- ToDo: [Clarify] Automation level: release script or manual checklist.
- ToDo: [Missing] No staging or pre-production environment is defined to rehearse releases and migrations against production-like data.
