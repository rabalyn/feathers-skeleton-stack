# 0049: Coordinated daily object export with a write pause, snapshotted by restic

- Status: Proposed
- Date: 2026-09-14
- Scope: Conditional (on object storage, ADR 0002)
- Source: [Technical architecture › Backup policy, S3-compatible object storage](../technical-architecture.md#backup-policy)
- Related: [0028](0028-daily-maintenance-job.md), [0035](0035-private-podman-networks.md), [0046](0046-bucket-layout.md), [0048](0048-postgresql-backup-restic-nfs.md), [0050](0050-nfs-backup-mount.md), [0051](0051-backup-container-isolation.md)

## Context

Database rows reference S3 objects. Backing them up independently can produce a restore where rows point to missing objects, or objects exist without rows. Copying a live MinIO data directory isn't a consistent backup.

## Decision

- Run a daily S3 object export alongside the database backup at **02:00 UTC**.
- During the coordinated window, briefly pause uploads and database writes that create or delete object references.
- Export the current bucket to an immutable, dated staging tree containing object bytes, metadata, and checksums, using an API-level export or supported bucket listing/download.
- Take the PostgreSQL dump and the restic snapshot, then resume writes.
- Store the object snapshot in a **separate encrypted restic repository** on NFS, initially using the protected operator-managed restic password.
- Retain 30 days of snapshots, including earlier object states after deletions.

## Consequences

- Restores yield a database and object set that match.
- Some writes are unavailable during the backup window every night.

## ToDos

- ToDo: [Missing] The pause mechanism: how the backup job tells the API to pause (maintenance flag in PostgreSQL or Valkey, an admin endpoint), what clients see (HTTP 503? retry?), and how resumption is guaranteed if the backup job crashes mid-way.
- ToDo: [Contradiction] "Briefly pause" doesn't fit a pause that spans a full bucket export, the database dump, and the restic snapshot; its length grows with data volume. Consider reordering to avoid a pause: dump the database first, then export objects while deletions are deferred (soft delete with a grace period), so every referenced object still exists.
- ToDo: [Contradiction] The backup policy alerts "when either backup job fails", implying two jobs, while this decision describes a single coordinated sequence.
- ToDo: [Clarify] The staging tree is a full plaintext copy of all objects on NFS every day. Define cleanup of dated trees after snapshotting, storage sizing, and how "immutable" is enforced.
- ToDo: [Contradiction] The staging tree holds **unencrypted** object bytes on NFS, while backups are described as encrypted storage (ADR 0050).
- ToDo: [Clarify] Which buckets are exported: uploads only, or also generated exports (ADR 0046)?
- ToDo: [Clarify] "API-level object export **or** supported bucket listing/download": pick one, along with the checksum algorithm and metadata format.
- ToDo: [Contradiction] Production stages on NFS while local/CI stage in an S3 bucket (ADR 0046), so the production sequence is tested only in drills.
- ToDo: [Clarify] How the maintenance job (ADR 0028) and releases (ADR 0039) avoid the backup window.
