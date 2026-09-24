# 0017: Restic backups to an NFS target, with the restore path tested in CI

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0006, 0047, 0048, 0050, 0051, 0052
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0013](0013-gdpr-export-and-retention.md), [0015](0015-testing-vitest-playwright.md), [0020](0020-object-storage-uploads.md), [0023](0023-secrets-management.md), [0025](0025-runtime-settings.md)

## Context

Backups that have never been restored are an assumption, not a protection. The previous design staged backups to an S3 bucket locally and to NFS in production, so the production backup path was first executed in production.

Rootless Podman can neither mount an NFS export inside a container nor run a kernel NFS server, so a local NFS container — the obvious way to get parity — does not work on a developer machine.

## Decision

### What is backed up

| Data | How | Restic repository |
| --- | --- | --- |
| PostgreSQL | `pg_dump`, direct connection with a dedicated read-only role | `db` |
| Object storage, `uploads` bucket | Read with read-only credentials over the `object` network | `objects` |
| Valkey | Its RDB snapshot file, from a read-only mount of Valkey's volume ([0010](0010-sessions-postgres-ratelimits-valkey.md)) | `state` |
| OpenBao | A raft snapshot through the OpenBao API, with a policy allowing nothing else ([0023](0023-secrets-management.md)) | `state` |

The `exports` bucket is **not** backed up. Exports can be regenerated and would otherwise outlive their seven-day retention inside backup snapshots ([0013](0013-gdpr-export-and-retention.md)).

### The backup target

The restic repositories live under `/srv/backups` inside the `backup` container. What backs that path differs, and this is a stated exception to [0001](0001-one-stack-every-environment.md):

| Environment | `/srv/backups` is |
| --- | --- |
| Local | A named volume |
| CI | A real NFS export: the runner installs an NFS server, mounts the export as root, and bind-mounts it into the container |
| Production | The real NFS export, mounted by the host through a root-owned systemd mount unit and bind-mounted into the container |

The backup job itself is identical everywhere; it only ever writes to a directory. NFS-specific behaviour — a missing mount, a read-only mount, UID squashing — is exercised in CI on every pipeline.

### The backup service

- Runs as a long-lived `backup` container with its own numeric UID/GID and its own credentials, on the `db`, `object` and `secrets` networks only ([0002](0002-service-inventory-and-networks.md)). It has no route to the API, the worker or Valkey.
- **Schedule and retention are runtime settings** ([0025](0025-runtime-settings.md)), read from PostgreSQL through its read-only role. Default: daily, retaining **31 daily snapshots** of each repository. Backups run by themselves and cannot be triggered from the application.
- Encrypts and deduplicates with restic. The restic password is delivered by OpenBao at runtime; its offline copy is kept in the team's KeePass store.
- Verifies the target is present and writable before writing or pruning. It never falls back to a local path, because a silent fallback fills the production disk with the backups meant to protect it.
- Writes structured log lines to the shared log volume, including an explicit success line per run, so Loki can alert on failures and on missing runs ([0021](0021-structured-logging.md), [0022](0022-observability-and-alerting.md)).

### Database and objects need no coordination

Objects are immutable and deletion is soft, with a purge delay validated to exceed backup retention ([0020](0020-object-storage-uploads.md)). A database dump can therefore only reference objects that still exist in the matching or a later object snapshot, and objects without a referencing row are harmless. The repositories are taken independently, in any order, with no write pause.

### The NFS mount is a dependency of the backup service, not of the application

An NFS outage must fail backups and raise an alert. It must not prevent the API, database or frontend from starting.

### Restore is tested, not documented

CI runs a full cycle on every pipeline: create the backup role from scratch, back up all repositories onto real NFS, restore into a clean database, bucket, Valkey and OpenBao, verify representative contents, and check that object references in the restored database resolve to objects that exist. This is a required check.

Every restore has two **mandatory post-steps**:

1. **Revoke all sessions**, because a restored database reinstates sessions revoked after the backup was taken ([0010](0010-sessions-postgres-ratelimits-valkey.md)).
2. **Re-apply erasures** from the log of erased surrogate IDs, because a restored database reinstates people erased after the backup was taken ([0013](0013-gdpr-export-and-retention.md)).

## Consequences

- The backup and restore path runs on every CI pipeline, so a regression surfaces within one commit rather than at the next incident.
- Developer machines do not exercise NFS; CI does.
- **Accepted risk: the NFS target is the only backup copy.** It protects against loss of the application host, not against loss of the NFS server or the site. A second, off-site copy is out of scope for now and must be revisited before the system holds data whose loss is unacceptable.
- The restic password is the single point of unrecoverability: losing both its runtime copy and the KeePass copy loses every backup. Restoring OpenBao additionally needs its unseal keys, also in KeePass.
