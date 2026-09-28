# 0048: Daily `pg_dump` encrypted with restic onto NFS, retained 30 days

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › Backup policy, PostgreSQL operations](../technical-architecture.md#backup-policy)
- Related: [0006](0006-backup-storage-boundary.md), [0047](0047-backup-objectives.md), [0049](0049-coordinated-object-backup.md), [0050](0050-nfs-backup-mount.md), [0051](0051-backup-container-isolation.md)

## Context

The database must be recoverable within the RPO without WAL archiving, and backups must stay encrypted outside the application's storage.

## Decision

- Run one scheduled `pg_dump` every day at **02:00 UTC**. Encrypt and deduplicate it with restic, and store the repository on the production NFS mount.
- Retain daily PostgreSQL backups for **30 days**.
- Production backup jobs verify that the NFS mount is present and writable before creating or pruning backups.
- Alert immediately when a backup job fails, and alert when no successful coordinated backup exists within 26 hours.
- In local development and CI, restic points at the local `s3` service.

## Consequences

- Up to 30 daily restore points.
- Backup storage lives outside the production host's disks.

## ToDos

- ToDo: [Clarify] Dump format (custom `-Fc` or plain SQL) and delivery (streamed to `restic backup --stdin` or a temporary file, which needs local disk). Compressed dumps deduplicate poorly.
- ToDo: [Missing] Schedule for `restic forget --prune` and `restic check`, and restic lock handling on NFS.
- ToDo: [Clarify] "One restic repository password", but there are two repositories (database and objects, ADR 0049). Does one password cover both?
- ToDo: [Clarify] Password storage: "a protected key file **or** rootless Podman secret". Pick one.
- ToDo: [Contradiction] "Alert immediately when **either** backup job fails" implies two independent jobs, while the object backup describes one coordinated sequence that includes the database dump (ADR 0049).
- ToDo: [Clarify] Retention is 30 daily snapshots only, with no weekly or monthly generations. Confirm this is intentional.
- ToDo: [Clarify] restic version pinning and the backup image source (ADR 0051).
