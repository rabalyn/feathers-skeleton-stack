# 0046: Separate buckets for uploads and exports; backup staging bucket only in local/CI

- Status: Proposed
- Date: 2026-09-14
- Scope: Conditional (see ADR 0002)
- Source: [Technical architecture › S3-compatible object storage](../technical-architecture.md#s3-compatible-object-storage)
- Related: [0002](0002-object-storage-v1.md), [0006](0006-backup-storage-boundary.md), [0043](0043-minio-object-storage.md), [0049](0049-coordinated-object-backup.md), [0052](0052-restore-drills.md)

## Context

User uploads and generated exports have different lifecycles and permissions. Backup workflows need a staging location in test environments.

## Decision

- v1 includes uploads and exports, with separate S3 buckets for application uploads and generated exports in production.
- A backup-staging bucket exists only in local/CI profiles. Production exports objects directly to the dated NFS staging tree (ADR 0049).
- In local and CI profiles, the object-storage volume is disposable. In production it is persistent application infrastructure.

## Consequences

- Retention and permissions can differ per bucket.
- Production object storage never holds backup data.

## ToDos

- ToDo: [Clarify] "Export" means two different things: (a) the user-facing export feature writing to the exports bucket, and (b) the backup "object export" into the NFS staging tree. Use distinct terms throughout.
- ToDo: [Missing] Exports bucket lifecycle: are generated exports temporary (automatic expiry), and are they backed up or treated as regenerable?
- ToDo: [Contradiction] Local/CI backup tests use an S3 staging bucket while production stages on NFS, so the production backup path is never exercised before production (ADR 0052).
- ToDo: [Missing] Bucket provisioning (who creates buckets, when) and the naming convention per environment.
- ToDo: [Contradiction] "v1 includes uploads and exports" conflicts with object storage being added only when a feature needs it (ADR 0002).
