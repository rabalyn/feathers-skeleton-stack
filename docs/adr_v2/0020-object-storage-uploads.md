# 0020: S3-compatible object storage with immutable keys and soft deletion

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0002, 0043, 0044, 0045, 0046, 0049
- Related: [0002](0002-service-inventory-and-networks.md), [0009](0009-tu-id-identity-model.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0016](0016-nginx-and-tls-everywhere.md), [0017](0017-nfs-backup-storage.md), [0018](0018-owasp-security-baseline.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md)

## Context

Every product built on this skeleton will need to accept files, so the upload mechanism is part of the skeleton from the start, exercised by documents and avatars ([0009](0009-tu-id-identity-model.md)). Binary content does not belong in PostgreSQL rows, and a self-hosted S3-compatible service keeps the deployment free of a third-party cloud account while giving the application a standard API.

## Decision

### Engine

**Garage** as the S3-compatible service, run as a container in every environment including production. It is a single lightweight binary, designed for self-hosting, actively maintained, and covers the S3 operations this application needs (put, get, list, delete, multipart).

Re-confirmed at implementation (2026-09-26): Garage **v2.4.1**, actively released (2.3 in April 2026 added single-node setup and key import). What running it here looks like:

- **TLS in front, inside the same image.** Garage's S3 endpoint does not speak TLS and its documentation says to put a reverse proxy in front. The `s3` image (`containers/s3/`) is the pinned Garage binary plus Nginx: Garage listens only on **unix sockets** (S3 and admin), Nginx terminates TLS on `:3900` (S3) and `:3903` (only `/metrics` and `/health`, for Prometheus and the healthcheck), with a certificate from the `certs` job like every internal listener ([0016](0016-nginx-and-tls-everywhere.md)). No plaintext leaves the container, and Garage's RPC stays on loopback. Both processes run under one entrypoint; if either exits, the container exits.
- **One node, one copy** (`replication_factor = 1`, layout set by `--single-node`); durability is the backup's job ([0017](0017-nfs-backup-storage.md)).
- **Each client has its own key**, generated in OpenBao and rendered both to the client and to the `s3` container ([0023](0023-secrets-management.md)). On every start the container creates missing buckets, imports each client's key (through the admin API on stdin, never in argv) and grants it; a key whose rendered value changed is replaced, which is how a key rotates. The grants live in the entrypoint: `api` and `worker` read and write `uploads` and `exports`; locally the integration tests have a key of their own (`test`), which production never has. There is no admin token: administration is the Garage CLI inside the container.

MinIO is deliberately not chosen: during 2025 it removed administrative features from its community console, stopped publishing prebuilt community images, and moved the repository toward maintenance, which makes a pinnable and security-maintained community image an open risk rather than a given.

### Buckets

| Bucket | Contents | Lifecycle | Backed up |
| --- | --- | --- | --- |
| `uploads` | Documents and avatars | Retained until the owning record is deleted or erased, then soft-deleted | Yes |
| `exports` | Generated GDPR data exports | Deleted after the export retention ([0013](0013-gdpr-export-and-retention.md)) | No ([0017](0017-nfs-backup-storage.md)) |

### Objects are immutable, deletion is soft

This is the decision that makes everything else simple:

- Object keys are **server-generated UUIDs**. A user-supplied filename is never part of a key; it is stored as metadata on the PostgreSQL row alongside size, checksum, content type, owner and timestamps.
- An object is **written once and never modified**. Replacing a file (a new avatar, for example) writes a new object and repoints the row.
- Deletion is **soft**: the row is marked deleted and the object is purged by a worker job ([0024](0024-background-jobs-bullmq.md)) after the purge delay. The delay is a runtime setting, default **32 days**, and the settings service rejects any value not longer than the backup retention ([0025](0025-runtime-settings.md)).

Because of this, the database and the object store can be backed up independently with no coordination and no write pause ([0017](0017-nfs-backup-storage.md)). A restored database can only ever reference objects that still exist; unreferenced objects may exist and are harmless.

### Access is mediated by the API

The browser never talks to the object store. All access goes through authorized Feathers operations, which check ownership and role ([0011](0011-casl-role-authorization.md)) and then stream bytes to or from Garage. The S3 endpoint is reachable only on the `object` network and is never routed by Nginx. Presigned URLs are deferred until transfer volume makes API-mediated streaming impractical.

### Upload validation and limits

- Maximum size per object: a runtime setting, validated to stay below Nginx's body size ceiling ([0016](0016-nginx-and-tls-everywhere.md)).
- **Quotas** are runtime settings: **100 MB per user** and **5 GB in total** by default. An upload that would exceed either is rejected before any byte is stored.
- An explicit allowlist of MIME types and extensions. The declared content type is verified against **magic-byte detection**; a mismatch is a rejection, not a correction.
- Transfers are streamed, never buffered whole in API memory.

### Serving

- Documents are served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- Avatars are the one case served **inline**, because an `<img>` needs it. Only an allowlist of raster formats — PNG, JPEG, WebP — is accepted for avatars, verified by magic bytes, served with `nosniff` and the verified content type. **SVG is never accepted as an avatar and never served inline**, which is what prevents an upload from becoming stored XSS ([0018](0018-owasp-security-baseline.md)).
- An avatar is visible to its owner, to `operator` and to `admin` only ([0011](0011-casl-role-authorization.md)).

### Privacy

Uploads are personal data. They appear in the data subject export and are deleted on erasure, which means the `uploads` bucket is part of the personal data registry in [0013](0013-gdpr-export-and-retention.md), not just the PostgreSQL tables.

## Consequences

- Backup gains a second repository but loses all coordination complexity.
- Soft deletion means storage is reclaimed on a delay, and quota accounting must decide whether soft-deleted objects count. They do not count against the user, but they do count against the total until purged.
- All object bytes traverse the API, costing API bandwidth and connections. Acceptable at this scale and reversible by adding presigned URLs later.
