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
| PostgreSQL | `pg_dump`, direct connection with a dedicated read-only role (`backup`, a member of `pg_read_all_data`, [0003](0003-postgresql-and-knex.md)) | `db` |
| Object storage, `uploads` bucket | Read with read-only credentials over the `object` network into a mirror directory, which restic backs up | `objects` |
| Valkey | Its RDB snapshot file, from a read-only mount of Valkey's volume ([0010](0010-sessions-postgres-ratelimits-valkey.md)) | `state` |
| OpenBao | A raft snapshot through the OpenBao API, with a policy allowing nothing else ([0023](0023-secrets-management.md)) | `state` |
| NetBox's database ([0031](0031-netbox-locations.md)) | `pg_dump` of `netbox`, like the application's | `netbox` |

The `exports` bucket is **not** backed up. Exports can be regenerated and would otherwise outlive their seven-day retention inside backup snapshots ([0013](0013-gdpr-export-and-retention.md)).

### The backup target

The restic repositories live under `/srv/backups` inside the `backup` container. What backs that path differs, and this is a stated exception to [0001](0001-one-stack-every-environment.md):

| Environment | `/srv/backups` is |
| --- | --- |
| Local | A named volume |
| CI | A real NFS export: the runner installs an NFS server, mounts the export as root, and bind-mounts it into the container |
| Production | The real NFS export, mounted by the host through a root-owned systemd mount unit and bind-mounted into the container |

The backup job itself is identical everywhere; it only ever writes to a directory. NFS-specific behaviour — a missing mount, a read-only mount, UID squashing — is exercised in CI on every pipeline.

In `compose.yaml` the target is `${BACKUP_TARGET:-backups}`: the named volume, or the host directory `BACKUP_TARGET` names. The generated production unit mounts the host path `/srv/backups` instead and carries `RequiresMountsFor=/srv/backups`, so the NFS mount is a dependency of the backup unit alone. The export belongs to the host's subordinate UID that the container's `backup` user (UID 1100) maps to under rootless Podman, and is exported with `root_squash`.

**A run never creates a repository.** An empty directory is what an export that failed to mount looks like. The repositories are created once, knowingly, by `init` (`scripts/backup.sh init`; locally `scripts/stack.sh up` does it for its volume, in CI the same on the NFS mount). Every run first checks that all four repositories exist and that a probe file can be written, and fails otherwise.

### The backup service

- Runs as a long-lived `backup` container with its own numeric UID/GID and its own credentials, on the `db`, `object` and `secrets` networks only ([0002](0002-service-inventory-and-networks.md)). It has no route to the API, the worker or Valkey.
- **Schedule and retention are runtime settings** ([0025](0025-runtime-settings.md)), read from PostgreSQL through its read-only role. Default: daily, retaining **31 daily snapshots** of each repository. Backups run by themselves and cannot be triggered from the application.
- Encrypts and deduplicates with restic. The restic password is delivered by OpenBao at runtime; its offline copy is kept in the team's KeePass store.
- Verifies the target is present and writable before writing or pruning. It never falls back to a local path, because a silent fallback fills the production disk with the backups meant to protect it.
- Writes structured log lines to the shared log volume, including an explicit success line per run, so Loki can alert on failures and on missing runs ([0021](0021-structured-logging.md), [0022](0022-observability-and-alerting.md)).

As built:

- The service is a Node entry point of the api's code base, `dist/backup.js`, like the worker's: it shares the configuration, settings store and logger. Its own image target `backup` adds restic 0.19 (the static binary of the official image) and `pg_dump` 18 from Alpine's `postgresql18-client`, the server's release, without the Perl version wrapper Debian's packages bring (decided 2026-10-03, with the move of the api image to Alpine, [0006](0006-feathersjs-typescript-api.md)). `setpriv` drops to the service user in the entrypoint. restic and `pg_dump` run as child processes; `pg_dump` runs through `restic backup --stdin-from-command`, so a failing dump fails the snapshot, and gets its password through its own environment only ([0023](0023-secrets-management.md)).
- It runs as `backup` (UID/GID 1100), with GID 1000, Valkey's group, as a second group for the snapshot file. The container starts as root only to create its log directory ([0021](0021-structured-logging.md)).
- The schedule is a five-field cron expression in `Europe/Berlin` time, re-read every 30 seconds. The service refuses to start without both settings or with a schedule that does not parse. One run at a time: a run started by hand (`scripts/backup.sh run`) while another is in progress is refused.
- Each repository is followed by `restic forget --keep-daily <retention> --prune`. restic also keeps the oldest snapshot while fewer days than the retention have one.
- The bucket is mirrored into the service's own volume, a file per object: objects are immutable, so a run fetches only the new ones and deletes the files of objects that are gone. The mirror costs host disk equal to the bucket, bounded by the total upload quota ([0025](0025-runtime-settings.md)).
- The `state` repository holds `valkey.rdb`, copied from Valkey's volume, and `openbao.snap`, fetched with the backup agent's token ([0023](0023-secrets-management.md)); both are staged, backed up together, and the staged files removed.
- `netbox` holds NetBox's database apart from `db`, so the latest snapshot of each repository is one dump. Added with NetBox on 2026-09-30: a target made before then needs `scripts/backup.sh init` once more (idempotent) before the next run, which otherwise fails for the missing repository. `scripts/backup.sh restore-netbox` restores it into a fresh database owned by the `netbox` login, refused while NetBox runs; it has no post-steps, since `netbox-setup` re-seeds and re-issues the api's token at the next start. NetBox's uploaded images and attachments (the `netbox-media` volume) are not backed up yet: nothing the skeleton seeds uses them, and a product that stores attachments there adds them.
- The S3 key of the backup service is granted read on `uploads` only. The s3 container's grant table is authoritative for write access too: a read grant takes away any write access a restore left behind.

### Database and objects need no coordination

Objects are immutable and deletion is soft, with a purge delay validated to exceed backup retention ([0020](0020-object-storage-uploads.md)). A database dump can therefore only reference objects that still exist in the matching or a later object snapshot, and objects without a referencing row are harmless. The repositories are taken independently, in any order, with no write pause.

### The NFS mount is a dependency of the backup service, not of the application

An NFS outage must fail backups and raise an alert. It must not prevent the API, database or frontend from starting.

### Restore is tested, not documented

CI runs a full cycle on every pipeline: create the backup role from scratch, back up all repositories onto real NFS, restore into a clean database, bucket, Valkey and OpenBao, verify representative contents, and check that object references in the restored database resolve to objects that exist. This is a required check.

**Restores are a host procedure**, `scripts/backup.sh`, run by an administrator like `scripts/openbao.sh`, because the backup service's credentials are read-only and stay so. restic runs in the backup container; the data goes in through the target containers:

| Target | `scripts/backup.sh` | How |
| --- | --- | --- |
| Database | `restore-db <database> [--replace]` | Created fresh like `app`, then `pg_restore` as the superuser over postgres's socket. `--replace` drops an existing database and is refused while the api or the worker runs |
| NetBox's database | `restore-netbox <database> [--replace]` | Created fresh, owned by the `netbox` login, then `pg_restore` as that login. `--replace` is refused while `netbox` or `netbox-worker` runs ([0031](0031-netbox-locations.md)) |
| Objects | `restore-objects <bucket> [--empty]` | Uploaded by the backup service with its own key, which the script grants write access to the bucket through Garage's admin API for the restore only, and takes back afterwards. `--empty` is refused for the production buckets |
| Valkey | `restore-valkey <volume>` | The RDB becomes the base of a new AOF in the stopped Valkey's volume, since Valkey with AOF on ignores a lone RDB ([0010](0010-sessions-postgres-ratelimits-valkey.md)) |
| OpenBao | `restore-openbao <container>` | `bao operator raft snapshot restore -force` with a root token from stdin, generated from the unseal key in production. OpenBao is then sealed and opens with the unseal key of the backed-up OpenBao |

`scripts/backup-test.sh` is the CI check. It runs the service's own run over `app` and `uploads`; a missing, an empty and a read-only target, each of which must fail; then the whole cycle on a source of its own (a migrated database `backup_check` with seeded rows, and objects in `backup-check`), backed up into repositories of its own under the real target and restored through `scripts/backup.sh` into `restore_check`, `restore-check`, a throwaway Valkey and a throwaway OpenBao. It checks rows, references and settings, that a change made after the backup is absent, that every session and API token is revoked, that every file row's object exists byte for byte, that Valkey loads with AOF on, and that the restored OpenBao opens with the stack's unseal key and holds its secrets. NetBox's own database is backed up with the rest and restored into `restore_netbox_check`, where its sites must have the same ids and belong to the `netbox` login. The local app's data is only read, and everything the check creates is removed. Its own runs log to stdout only, so they neither raise nor satisfy the backup alerts.

Every restore has two **mandatory post-steps**:

1. **Revoke all sessions and API tokens**, because a restored database reinstates sessions and tokens revoked after the backup was taken ([0010](0010-sessions-postgres-ratelimits-valkey.md), [0029](0029-api-tokens.md)). Tokens are deleted, and their owners create new ones.
2. **Re-apply erasures** from the log of erased surrogate IDs, because a restored database reinstates people erased after the backup was taken ([0013](0013-gdpr-export-and-retention.md)).

`restore-db` does both itself. The log of erasures lives in the database a restore replaces, so `restore-db` reads it before it drops or restores anything: from `--erasures-from <database>`, else from the target database when it exists, else from `app`. It keeps it in a file whose path it prints, and afterwards erases every listed account again with its original time ([0013](0013-gdpr-export-and-retention.md)). `replay-erasures <database> --erasures-file <file>` repeats that step alone, for a restored schema that has to be migrated first. `backup-test.sh` erases an account after its backup and checks that the restore erases it again, with the same time, and nobody else.

## Consequences

- The backup and restore path runs on every CI pipeline, so a regression surfaces within one commit rather than at the next incident.
- Developer machines do not exercise NFS; CI does. A developer can, with `sudo scripts/ci-nfs-runner.sh` ([0015](0015-testing-vitest-playwright.md)).
- The `Backup missing` alert fires wherever no run has completed within 26 hours, a fresh deployment and a local stack included ([0022](0022-observability-and-alerting.md)).
- **Accepted risk: the NFS target is the only backup copy.** It protects against loss of the application host, not against loss of the NFS server or the site. A second, off-site copy is out of scope for now and must be revisited before the system holds data whose loss is unacceptable.
- The restic password is the single point of unrecoverability: losing both its runtime copy and the KeePass copy loses every backup. Restoring OpenBao additionally needs its unseal keys, also in KeePass.
