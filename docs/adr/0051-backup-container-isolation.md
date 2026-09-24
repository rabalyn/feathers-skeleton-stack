# 0051: Run backups in an isolated, unattended rootless container with separate credentials

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › Backup policy, PostgreSQL operations](../technical-architecture.md#backup-policy)
- Related: [0015](0015-database-roles-and-connection-paths.md), [0035](0035-private-podman-networks.md), [0048](0048-postgresql-backup-restic-nfs.md), [0049](0049-coordinated-object-backup.md), [0065](0065-alerting.md), [0067](0067-secrets-and-configuration.md)

## Context

The backup job holds read access to all data and the encryption key for all backups, so it should be the most isolated component.

## Decision

- Run the unattended rootless `backup` container with a dedicated numeric UID/GID.
- Give it private-network access to PostgreSQL for direct `pg_dump` connections, but no application-facing network access.
- Mount `/srv/backups` at a fixed path.
- Store one restic repository password in a protected key file or rootless Podman secret mounted read-only. The single operator owns this password and keeps a separate offline recovery copy; losing it makes the encrypted repositories unrecoverable.
- Restrict who can read or delete backups, and keep backup credentials separate from application credentials.
- Test restore access whenever the host or backup configuration changes.

## Consequences

- An application compromise doesn't directly grant backup credentials.
- Losing the offline password copy means losing all backups.

## ToDos

- ToDo: [Contradiction] The container joins the `backend` network, which also contains the API and Valkey, so it does have application-facing network access (ADR 0035).
- ToDo: [Contradiction] The coordinated write pause (ADR 0049) requires the backup job to signal the API, which conflicts with "no application-facing network access". Define the coordination channel.
- ToDo: [Clarify] The job needs delete rights for `restic forget --prune`, so a compromised host can delete every backup. Is NFS-provider snapshotting the only protection, or should an append-only design (for example a restic REST server in append-only mode) be used?
- ToDo: [Missing] Scheduling (systemd timer starting a Quadlet one-shot?) and how success or failure reaches Prometheus or alerting, since Prometheus has no network path to the backup container (ADR 0065).
- ToDo: [Missing] S3 read-only credentials for the object export.
- ToDo: [Clarify] Who triggers and records "test restore access whenever the host or backup configuration changes".
