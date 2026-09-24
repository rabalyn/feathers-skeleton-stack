# 0050: Dedicated, mandatory NFS mount at `/srv/backups` with no local fallback

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › S3-compatible object storage, Backup policy, Deployment-Specific Configuration](../technical-architecture.md#s3-compatible-object-storage)
- Related: [0006](0006-backup-storage-boundary.md), [0034](0034-single-host-rootless-quadlet.md), [0036](0036-rootless-non-root-containers.md), [0047](0047-backup-objectives.md), [0070](0070-deployment-specific-configuration.md)

## Context

Backups must not live on the disks they protect, and silently writing backups to the local disk could fill the production host.

## Decision

- Production database and object backups are stored on an NFS-mounted path accessible from the production host, not in production S3.
- The NFS provider supplies snapshots for logical recovery. This setup doesn't protect against NFS server, disk, or site loss; replication or a second off-site copy is required before claiming host-disaster protection.
- Use a dedicated NFS backup export mounted at a fixed path, `/srv/backups`, rather than a shared general-purpose export.
- The NFS source is a private DNS hostname and export path supplied by deployment configuration (for example `backup-nfs.internal:/exports/app-backups`). No real hostname or IP address is committed.
- The systemd NFS mount unit is required before the whole production stack starts, verifies that `/srv/backups` is really mounted, and fails startup clearly when NFS is unavailable. It never falls back to a local directory.
- An unavailable NFS mount is a backup failure that triggers an alert.
- The backup container uses a dedicated numeric UID/GID authorized by the NFS export, not the deployment user's identity.
- Document the export, mount point, ownership, permissions, encryption key handling, and the provider's snapshot or replication policy.

## Consequences

- Backups can't silently land on local disk.
- NFS availability becomes an operational dependency.

## ToDos

- ToDo: [Contradiction] Making the mount a prerequisite for "the whole production stack" means an NFS outage during boot or restart stops the API, database, and web, although NFS is only used for backups. The backup policy treats the same condition as "a backup failure" to alert on. Decide: should only the backup unit depend on the mount?
- ToDo: [Verify] Rootless Quadlet units run in the user's systemd manager and can't express `Requires=`/`After=` on the system-level `srv-backups.mount`. Enforcement needs, for example, a `mountpoint -q /srv/backups` pre-start check in the backup unit, or system-level units.
- ToDo: [Verify] Under rootless Podman the "dedicated numeric UID/GID" reaches the NFS server as a subordinate host UID; the export must authorize that mapped ID (ADR 0036).
- ToDo: [Clarify] NFS version and security flavour (`AUTH_SYS` trusts client-asserted UIDs; Kerberos?), mount options (`hard`/`soft`, timeouts), and encryption in transit. The plaintext object staging tree also travels and rests unencrypted (ADR 0049).
- ToDo: [Clarify] Who provisions the host-level mount unit: this repository (listed as a pre-production deliverable, ADR 0070) or the infrastructure repository (ADR 0004)?
- ToDo: [Clarify] The path is called both "a fixed path **such as** `/srv/backups`" and "a fixed `/srv/backups` mount". Confirm it is fixed.
- ToDo: [Missing] Who documents and owns the NFS provider's snapshot and replication policy, and when the off-site copy arrives (ADR 0047).
