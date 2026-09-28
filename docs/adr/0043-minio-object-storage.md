# 0043: Self-host S3-compatible object storage (MinIO as initial candidate)

- Status: Proposed
- Date: 2026-09-14
- Scope: Conditional (see ADR 0002)
- Source: [Technical architecture › S3-compatible object storage](../technical-architecture.md#s3-compatible-object-storage)
- Related: [0002](0002-object-storage-v1.md), [0006](0006-backup-storage-boundary.md), [0044](0044-api-mediated-object-access.md), [0046](0046-bucket-layout.md), [0049](0049-coordinated-object-backup.md)

## Context

The application needs binary storage for uploads and generated artifacts without depending on a third-party cloud account.

## Decision

- Local Compose and production Quadlet provide an S3-compatible object storage service in a rootless Podman container with persistent storage.
- MinIO is the initial candidate. Pin a tested release or image digest and update it deliberately, after object backup and restore testing.
- The API uses the internal service name and port. The storage console and S3 port bind to localhost or a private network unless external access is explicitly required.
- The production S3 service isn't a third-party dependency; it is deployed and operated with the rest of the stack.
- Bucket names, endpoint, region, and path-style setting are configurable through environment variables.
- S3 holds application object data (uploads, images, exports), generated artifacts unsuitable for PostgreSQL rows, and, in local/CI only, staging for encrypted backup archives. It doesn't hold users, sessions, activity records, relational data, PostgreSQL storage, Prometheus metrics, Loki logs, or Grafana data.
- Never copy a live MinIO data directory as if it were a consistent backup.

## Consequences

- The same S3 API is used in all environments.
- Durability of object data depends on this deployment's backups.

## ToDos

- ToDo: [Verify] Since 2025 MinIO has cut back its community edition: admin features were removed from the community console, prebuilt community images and binaries stopped being published, and the repository was put into maintenance mode. Confirm that a pinnable, security-maintained MinIO image still exists, or evaluate alternatives (for example Garage, SeaweedFS, RustFS, Ceph RGW, or commercial MinIO AIStor).
- ToDo: [Clarify] "Initial candidate" isn't a final decision. Define acceptance criteria and a decision date.
- ToDo: [Contradiction] "Bound to localhost or a private network unless external access is explicitly required" leaves an exception, while elsewhere S3 "remains private and is reachable only by the API and backup jobs". Remove the exception or define its approval path.
- ToDo: [Missing] Provisioning of buckets, per-service access keys, and policies (API read/write, backup read-only), and the "local S3 administration" credential mentioned in ADR 0067.
- ToDo: [Clarify] Single-node, single-drive mode offers no redundancy or bit-rot protection. Durability relies entirely on daily backups (ADR 0049), which means up to 48 hours of object loss.
- ToDo: [Contradiction] "Must have a volume backup or replication plan" leaves replication open, while the backup policy settles on a daily API-level export. Drop "or replication"?
- ToDo: [Missing] Health check and metrics exposure for the S3 service.
- ToDo: [Verify] License obligations (MinIO community edition is AGPLv3) are acceptable.
