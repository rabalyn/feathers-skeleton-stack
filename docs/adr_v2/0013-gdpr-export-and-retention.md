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
- A `user` may export their own data. An `admin` may export any user's data. Both are audited.
- Completeness is enforced by a **personal data registry**: a single module that names every store holding personal data — PostgreSQL tables and object storage buckets alike — and how each contributes to an export. A new table holding personal data must be added to the registry, and a test fails if a table carrying a user foreign key is absent from it.
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

Erasure is an **administrative action only**; there is no self-service erasure.

Erasure clears direct identifiers — TU-ID, name, surname, email, avatar — from the user record and from audit events, while keeping the surrogate key and the rows that reference it. This preserves referential integrity and the accountability value of the audit trail without retaining an identifiable person. It is possible only because the primary key is a surrogate ([0009](0009-tu-id-identity-model.md)).

Files uploaded by an erased user are soft-deleted and purged on the normal schedule ([0020](0020-object-storage-uploads.md)), so they leave the object store and fall out of backups within the retention window rather than persisting indefinitely.

Documents owned by an erased user are deleted. Products decide per resource type whether their own records are transferred or deleted, when that resource is designed.

### Erasure and backups

Backups are not rewritten on erasure. Erased data leaves the backups when the snapshots holding it expire (31 days). In the meantime backups are used for nothing except restores, and **after a restore, erasures are applied again from a log of erased surrogate IDs**. That log holds surrogate IDs and timestamps only, so it identifies nobody by itself. Re-applying it is a mandatory restore step alongside revoking all sessions ([0017](0017-nfs-backup-storage.md)).

### Data minimisation

- The SAML SP requests only the attributes it uses: `cn` (TU-ID), name, surname, email.
- Logs carry the surrogate id, not the TU-ID ([0009](0009-tu-id-identity-model.md)), so the 14-day log retention does not accumulate direct identifiers.
- Audit events record what was done, by which account, to which resource — never request bodies, credentials, or assertion contents.

### Organisational deliverables

A **record of processing activities** (Art. 30 GDPR) and a **data protection impact assessment** (Art. 35 GDPR) are prepared together with the institutional data protection officer before production. They are organisational documents, not code, but the skeleton's registry, retention table and erasure semantics are their technical basis. Each product built on the skeleton extends them for its own data.

## Consequences

- Export completeness is a maintained invariant with a test behind it, rather than a claim.
- Retention can be changed at runtime without a release; the bootstrap guarantees every setting exists.
- Erased users remain visible in audit history as a pseudonymous id, which is the intended balance between accountability and erasure.
- Restores carry two mandatory post-steps (session revocation, erasure replay); skipping either reinstates data or access that was removed.
