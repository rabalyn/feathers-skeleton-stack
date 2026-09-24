# 0047: Best-effort RPO of 48 hours and RTO of 4 hours; defer WAL archiving

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production); PITR Deferred
- Source: [Technical architecture › Backup policy](../technical-architecture.md#backup-policy)
- Related: [0048](0048-postgresql-backup-restic-nfs.md), [0049](0049-coordinated-object-backup.md), [0050](0050-nfs-backup-mount.md), [0052](0052-restore-drills.md)

## Context

Backup design depends on how much data loss and downtime are acceptable. Continuous archiving adds operational complexity.

## Decision

- Initial target: best-effort **RPO 48 hours** and **RTO 4 hours**. The 48-hour figure reflects daily dumps, the risk of a missed run, and the absence of WAL archiving.
- The application team owns backup jobs, encrypted storage, retention, the restore procedure, and restore drills.
- Continuous WAL archiving and point-in-time recovery are a future milestone for when 48 hours becomes insufficient.
- Backup data and credentials are separate from application credentials, and read/delete access to backups is restricted.

## Consequences

- Up to two days of data can be lost in the worst case.
- Simple daily jobs instead of continuous archiving.

## ToDos

- ToDo: [Contradiction] "The application team owns the backup jobs…" versus "the single operator owns this [restic] password" and one owner per alert. Is there a team or a single operator? A single password holder is a bus-factor risk.
- ToDo: [Clarify] Which failure scenarios the 4-hour RTO covers. NFS offers no protection against NFS server, disk, or site loss. Losing the host means rebuilding the host, secrets, and locally built images (no registry, ADR 0038) before restoring. Is 4 hours realistic for that?
- ToDo: [Missing] An off-site or second copy is "required before claiming host-disaster protection". Is it planned for v1 or deferred?
- ToDo: [Missing] Backup of non-data state needed to recover: secrets, Quadlet and environment files, Grafana configuration (ADR 0064), release manifests.
- ToDo: [Clarify] A measurable trigger for the WAL-archiving milestone.
- ToDo: [Clarify] Restore drills should measure restore duration against the RTO (ADR 0052).
