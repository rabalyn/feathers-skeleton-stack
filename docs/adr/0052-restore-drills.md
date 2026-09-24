# 0052: Monthly full restore drills and CI restore tests define backup validity

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › Backup policy, PostgreSQL operations](../technical-architecture.md#backup-policy)
- Related: [0015](0015-database-roles-and-connection-paths.md), [0024](0024-refresh-session-storage.md), [0039](0039-release-procedure-and-rollback.md), [0046](0046-bucket-layout.md), [0047](0047-backup-objectives.md)

## Context

Backups that have never been restored give no real assurance.

## Decision

- Test a full restore **monthly**: restore both repositories, check that database object references resolve, compare object counts and checksums, download representative files, and record the result.
- A backup isn't considered valid until this produces a usable database and object set.
- CI creates the backup role from scratch, runs a full dump, restores into a clean database, and verifies representative contents.
- Document who can start a restore, where the restored database is created, how application access is paused, and how the restored version is verified.

## Consequences

- Backup regressions are found within a month in production and on every CI run for the database path.
- Drills take operator time and host resources.

## ToDos

- ToDo: [Missing] Target environment for the monthly drill: the production host (resource impact, name clashes) or a separate machine?
- ToDo: [Missing] Restore authority and a runbook. The architecture lists these as things "to document" but doesn't decide them.
- ToDo: [Missing] A post-restore security step. Refresh sessions revoked after the backup was taken become valid again; revoke all `auth_sessions` or rotate the JWT signing key after every production restore (ADR 0024).
- ToDo: [Contradiction] CI exercises backups against the local S3 staging bucket while production uses NFS (ADR 0046), so the production path is verified only by the monthly drill.
- ToDo: [Clarify] Where drill results are recorded (repository document, issue, Grafana annotation).
- ToDo: [Clarify] Measure restore duration against the 4-hour RTO (ADR 0047).
- ToDo: [Clarify] Implement "object references resolve" as a script shipped with the backup image?
- ToDo: [Missing] The CI restore test isn't in the CI check list (ADR 0056).
