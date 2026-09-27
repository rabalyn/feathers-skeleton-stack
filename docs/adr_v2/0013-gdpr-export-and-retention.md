# 0013: GDPR data export, retention as runtime settings, and erasure semantics

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0027, 0061 (retention portion)
- Related: [0009](0009-tu-id-identity-model.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0017](0017-nfs-backup-storage.md), [0020](0020-object-storage-uploads.md), [0021](0021-structured-logging.md), [0022](0022-observability-and-alerting.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md)

## Context

The application processes personal data of university members under GDPR. Data subject access and erasure, and bounded retention, are obligations rather than features, so they are designed in from the start instead of retrofitted.

## Decision

### Data subject export

- A `data-exports` service produces a machine-readable (JSON) export of everything the system holds about one person.
- **The minimal export**, common to every product built on this skeleton, is: TU-ID, name, surname and email; the user's sessions; their audit events; and their uploads — avatar and documents with their metadata and files ([0020](0020-object-storage-uploads.md)). Products extend it through the registry below; they never shrink it.
- Every account may export its own data, whatever its role: the right of access is the person's, so an `operator` may too ([0011](0011-casl-role-authorization.md)). An `admin` may export any user's data. Both are audited.
- Completeness is enforced by a **personal data registry**: a single module that names every store holding personal data — PostgreSQL tables and object storage buckets alike — and how each contributes to an export. A new table holding personal data must be added to the registry, and a test fails if a table carrying a user foreign key is absent from it.
- As built, the registry is `apps/api/src/gdpr/registry.ts`. Each table entry names its columns referencing `users(id)`, the export key it fills and the rows it contributes, and its erasure rule (`clear-identifiers`, `delete`, `soft-delete` or `keep`); each bucket entry says whether the export carries its objects. `test/integration/gdpr-registry.test.ts` compares the registry's user columns with the foreign keys of the migrated schema, both ways, and checks that every production bucket is listed and that the erasure function handles every table whose rule is not `keep`. Tables without information about the person (refresh token hashes, the break-glass password hash, the erasure log) are listed with the reason they are not exported.
- As built, an export is a **ZIP**: `export.json`, which holds everything the registry collects under one key per store, and the person's files under `files/<id>/<filename>` with their original bytes, each filename reduced to one path segment. Requesting one (`POST /api/data-exports` with the subject's id) writes a `data_exports` row and its audit event in one transaction, then enqueues a job on the worker's `data-exports` queue ([0024](0024-background-jobs-bullmq.md)). The worker streams the ZIP into the bucket as a multipart upload, one file at a time, and records size and SHA-256 on the row. The api relays the outcome to the requester's browser as a `patched` event ([0012](0012-role-scoped-channels.md)), and the requester downloads it at `GET /api/data-export-contents/<id>`. Every download is audited.
- **Only the account that asked for an export sees and fetches it**: an admin's export of someone else goes to the admin, who hands it over. The subject learns of it from the audit events in their own export. There is at most one pending export per person, and a second request is refused with 409. A missing or erased subject gets the same 400. An export whose last attempt fails is marked `failed` and may be requested again.
- Generated exports are written to the `exports` bucket and deleted when the export retention passes. The `exports` bucket is excluded from backups ([0017](0017-nfs-backup-storage.md)): exports can be regenerated and would otherwise outlive their own retention inside backup snapshots.

### Retention is a runtime setting

Retention periods the application enforces are runtime settings in PostgreSQL ([0025](0025-runtime-settings.md)), seeded with defaults by the bootstrap and editable by `admin`. Retention enforced by Loki and Prometheus is deployment configuration, because those stores read their own configuration files; it is also a GDPR guarantee that is better kept out of a UI.

| Data | Default | Kind | Enforced by |
| --- | --- | --- | --- |
| Application logs | 14 days | Deployment config | Loki compactor ([0021](0021-structured-logging.md)) |
| Metrics | 14 days | Deployment config | Prometheus retention ([0022](0022-observability-and-alerting.md)) |
| Audit / activity events | 90 days | Runtime setting | Maintenance job |
| Expired sessions | 30 days after family expiry | Runtime setting | Maintenance job |
| Generated data exports | 7 days | Runtime setting | Maintenance job |
| Soft-deleted objects | 32 days, validated to exceed backup retention | Runtime setting | Purge job ([0020](0020-object-storage-uploads.md)) |
| Backups | 31 days | Runtime setting | Backup service ([0017](0017-nfs-backup-storage.md)) |

Maintenance and purge jobs run in the worker ([0024](0024-background-jobs-bullmq.md)) and delete in batches.

### Erasure

Erasure is an **administrative action only**; there is no self-service erasure. As built it is `POST /api/erasures` with the user's surrogate id. It is refused for the admin's own account and for the break-glass account, which holds no personal data and is the recovery path; an already erased account gets 409. Every erasure is an audit event (`users.erase`), and the web UI offers it on an admin GDPR page ([0014](0014-frontend-quasar-vue.md)).

Erasure clears direct identifiers — TU-ID, name, surname, email, avatar — from the user record, while keeping the surrogate key and the rows that reference it. This preserves referential integrity and the accountability value of the audit trail without retaining an identifiable person. It is possible only because the primary key is a surrogate ([0009](0009-tu-id-identity-model.md)). Audit events are kept unchanged: they reference accounts by surrogate id and never carry a direct identifier (see *Data minimisation*), so there is nothing in them to clear. The erased account is disabled, and a later login by the same person creates a new account, since nothing links them to the old one any more.

The user's sessions and their refresh tokens are deleted, because they hold the user agent and the IdP's name for the person, and the user's sockets are closed ([0012](0012-role-scoped-channels.md)), so erasure also logs them out everywhere at once.

The erasure is one database function, `erase_user(id, erased_at)`, created by a migration, so the api and the restore procedure apply exactly the same rules, and the restore needs nothing but `psql`. It is idempotent and does nothing for an id no user has. A product whose table needs an erasure rule other than `keep` replaces the function in the migration that adds the table; the registry test fails until it does.

Files uploaded by an erased user are soft-deleted and purged on the normal schedule ([0020](0020-object-storage-uploads.md)), so they leave the object store and fall out of backups within the retention window rather than persisting indefinitely.

Documents owned by an erased user are deleted. Products decide per resource type whether their own records are transferred or deleted, when that resource is designed.

### Erasure and backups

Backups are not rewritten on erasure. Erased data leaves the backups when the snapshots holding it expire (31 days). In the meantime backups are used for nothing except restores, and **after a restore, erasures are applied again from a log of erased surrogate IDs**. That log holds surrogate IDs and timestamps only, so it identifies nobody by itself. Re-applying it is a mandatory restore step alongside revoking all sessions ([0017](0017-nfs-backup-storage.md)).

The log is the `erasures` table of the application database, written by `erase_user()`. Because a restore replaces the very database that holds it, `scripts/backup.sh restore-db` reads the log first: from the database named by `--erasures-from`, else from the database being replaced, else from `app`. It keeps a copy in a file and, after the restore, calls `erase_user()` for every entry with its original time. This covers every restore except the loss of the host with its database: then the erasures made since the last backup are lost with everything else, and the people erased in that window reappear from the backup. The risk is bounded by the daily backup interval and accepted together with the missing off-site copy ([0017](0017-nfs-backup-storage.md)). An erasure the log names but the restored database lacks the function for (a backup older than this schema) stops the restore with the command to replay the kept file after migrating.

### Data minimisation

- The SAML SP requests only the attributes it uses: `cn` (TU-ID), name, surname, email.
- Logs carry the surrogate id, not the TU-ID ([0009](0009-tu-id-identity-model.md)), so the 14-day log retention does not accumulate direct identifiers.
- Audit events record what was done, by which account, to which resource — never request bodies, credentials, or assertion contents.

### Audit event store

Audit events are rows of one `audit_events` table: time, acting account (surrogate id, null for the system), action, resource type and id, the request id ([0021](0021-structured-logging.md)) where there is one, and a small JSON detail — the changed fields of an administrative change, never a body. The table exists from slice 2, written for logins and refused logins, logouts, detected refresh token reuse, role and enable/disable changes, and runtime settings changes ([0025](0025-runtime-settings.md)). A change and its audit event commit in one transaction where the change is a database write. As built, `audit-events` is a read-only service: `admin` and `operator` read every event, everyone else the events they caused ([0011](0011-casl-role-authorization.md)), newest first and filterable by actor, action and resource. Nothing is written through it, so it publishes no events. In an export, a person's audit events are those they caused, those about their account, and those whose detail names them as the subject of an export.

### Organisational deliverables

A **record of processing activities** (Art. 30 GDPR) and a **data protection impact assessment** (Art. 35 GDPR) are prepared together with the institutional data protection officer before production. They are organisational documents, not code, but the skeleton's registry, retention table and erasure semantics are their technical basis. Each product built on the skeleton extends them for its own data.

## Consequences

- Export completeness is a maintained invariant with a test behind it, rather than a claim.
- Retention can be changed at runtime without a release; the bootstrap guarantees every setting exists.
- Erased users remain visible in audit history as a pseudonymous id, which is the intended balance between accountability and erasure.
- Restores carry two mandatory post-steps (session revocation, erasure replay); skipping either reinstates data or access that was removed.
