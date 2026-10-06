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
- **Each client has its own key**, generated in OpenBao and rendered both to the client and to the `s3` container ([0023](0023-secrets-management.md)). On every start the container creates missing buckets, imports each client's key (through the admin API on stdin, never in argv) and grants it; a key whose rendered value changed is replaced, which is how a key rotates. The grants live in the entrypoint: `api` and `worker` read and write `uploads` and `exports`; locally the integration tests have a key of their own (`test`), which production never has. The grant table is the whole truth: a grant it no longer lists is revoked at the next start. Locally, `S3_LOCAL_GRANTS` (interpolated in `compose.yaml`, so never in the generated units) adds the buckets of test runs: `test-uploads`, `test-purge`, `test-exports` and `test-data-exports` for the integration tests (the purge and data export tests each have a bucket of their own, because their orphan sweeps remove every object without a row), `e2e-uploads` and `e2e-exports` for the end-to-end api and worker. Each run empties its buckets at its start and end, as it recreates its databases ([0015](0015-testing-vitest-playwright.md)), so test objects never land in, or pile up next to, the local application's `uploads`. There is no admin token: administration is the Garage CLI inside the container.

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

As built:

- **One `files` table describes every object** in `uploads`: owner, original filename, verified content type, size, SHA-256, and its bookkeeping (`pending` while an upload is in flight, `stored` once complete; when it was attached; when it was soft-deleted). Its id is the object key. Documents and avatars reference a `files` row; a new kind of attachment in a product does the same, so quota, purge, export and backup checks work on one table.
- **Upload** is `POST /api/files` with the file as the raw body, its type as `Content-Type` and its name percent-encoded in `X-File-Name`; multipart is not used. It answers with the file's metadata; the uploader then attaches the file by its id (`documents.create({ title, fileId })`, `avatars.create({ fileId })`). Attaching requires a stored, unattached file of the caller's own, of a type the target allows. A file never attached is soft-deleted by the purge job after 24 hours, and a `pending` row older than an hour (an upload the API never finished) is removed with its partial object ([0024](0024-background-jobs-bullmq.md)). Both grace periods are code constants, not settings: they bound bookkeeping, not policy.
- **Download** is `GET /api/file-contents/<id>`, readable by the file's owner and by whoever may read the record that attaches it: the user whose avatar it is, the document whose file it is ([0011](0011-casl-role-authorization.md)). Every record that attaches files besides the avatar is listed in `FILE_REFERENCES` (`services/files/attachments.ts`): its table, its file column, and the service whose read rule is asked; a product lists its own in `apps/api/src/product/files.ts`, and an integration test holds the list against every foreign key to `files` ([0035](0035-products-derived-from-the-skeleton.md), decided 2026-10-06). Each check is the caller's own rule on that record, in a view-as the intersected one ([0028](0028-read-only-view-as.md)). A file nothing attaches is its owner's alone. Every refusal is a **404** worded exactly like an id that does not exist. Decided 2026-10-02; until then the check was the rule over files, which `users.read` and `documents.all` granted for every file. The browser fetches it with its access token, which is held in memory only ([0014](0014-frontend-quasar-vue.md)), so an `<img>` shows an avatar from a blob URL rather than from the API's URL.
- **Avatars** are set through their own `avatars` service, which acts on the caller's own record only; `users.patch` stays limited to role and account state ([0011](0011-casl-role-authorization.md)). Replacing a document's file or an avatar releases the previous file by soft deletion in the same transaction. Only the document's owner replaces its file ([0011](0011-casl-role-authorization.md)).

### Upload validation and limits

- Maximum size per object: a runtime setting, validated to stay below Nginx's body size ceiling ([0016](0016-nginx-and-tls-everywhere.md)).
- **Quotas** are runtime settings: **100 MB per user** and **5 GB in total** by default. An upload that would exceed either is rejected before any byte is stored.
- An explicit allowlist of MIME types and extensions. The declared content type is verified against **magic-byte detection**; a mismatch is a rejection, not a correction.
- Transfers are streamed, never buffered whole in API memory.
- SVG was reconsidered on 2026-09-26 and stays out: it has no magic bytes, and accepting it safely means parsing and rejecting scripts, event handlers and external references, a checker that must be complete. Vector graphics go up as PDF.
- The allowlist is PDF, PNG, JPEG and WebP (`apps/api/src/uploads.ts`): only formats whose magic bytes identify them. Products extend it there; a format that a signature cannot tell apart from others (ZIP-based office files, plain text) needs more than a signature check before it is added.
- In order, as built: type on the allowlist, else **415**; `Content-Length` present, else **411** (a chunked upload cannot be checked against quota before it is stored); size within the maximum, else **413**; the first bytes match the declared type, else **415**; then, under a lock that serialises reservations, the quotas, else **413** with the reason, and a `pending` row reserves the space. Only then do bytes go to Garage, hashed and counted; a body shorter or longer than declared aborts the write, and any failure removes the row and the partial object.

### Serving

- Documents are served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. Every download also carries the verified type, the filename per RFC 6266, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, no-store`.
- Avatars are the one case served **inline**, because an `<img>` needs it. Only an allowlist of raster formats — PNG, JPEG, WebP — is accepted for avatars, verified by magic bytes, served with `nosniff` and the verified content type. **SVG is never accepted as an avatar and never served inline**, which is what prevents an upload from becoming stored XSS ([0018](0018-owasp-security-baseline.md)).
- An avatar is visible to whoever may read its user: with the seeded roles, its owner, `operator` and `admin` ([0011](0011-casl-role-authorization.md)).
- An avatar is served under a name of the server's choosing, `avatar.png`, `avatar.jpg` or `avatar.webp` after its verified type, never the uploader's, so saving it cannot yield a file a desktop would open as something else. Attachments keep their original name. Decided 2026-10-02.

### Privacy

Uploads are personal data. They appear in the data subject export and are deleted on erasure, which means the `uploads` bucket is part of the personal data registry in [0013](0013-gdpr-export-and-retention.md), not just the PostgreSQL tables.

## Consequences

- Backup gains a second repository but loses all coordination complexity.
- Soft deletion means storage is reclaimed on a delay, and quota accounting must decide whether soft-deleted objects count. They do not count against the user, but they do count against the total until purged.
- All object bytes traverse the API, costing API bandwidth and connections. Acceptable at this scale and reversible by adding presigned URLs later.
