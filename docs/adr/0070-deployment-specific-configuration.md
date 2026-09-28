# 0070: Keep deployment-specific values outside the repository; define pre-production deliverables

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (before first production release)
- Source: [Technical architecture › Deployment-Specific Configuration](../technical-architecture.md#deployment-specific-configuration)
- Related: [0004](0004-repo-vs-infrastructure-boundary.md), [0034](0034-single-host-rootless-quadlet.md), [0050](0050-nfs-backup-mount.md), [0067](0067-secrets-and-configuration.md)

## Context

Some values (private hostnames, export paths) are environment facts that don't belong in version control. The architecture also lists what implementation must deliver before production.

## Decision

- The real private NFS hostname and export path are supplied outside the repository once production infrastructure exists. They live in protected deployment configuration, never in an ADR or committed environment file.
- Before production, the implementation must provide: Quadlet units, the NFS mount unit, backup container configuration, Alloy host-service configuration, test Nginx configuration, refresh-session migrations, and the health/metrics access rules.

## Consequences

- The repository stays free of environment-specific infrastructure details.
- A production readiness checklist exists.

## ToDos

- ToDo: [Missing] The deliverables list omits items required by other ADRs: Valkey unit (0001), exporters (0035), Prometheus/Grafana/Loki configuration (0064), migration, maintenance, and bootstrap jobs (0012, 0028, 0059), email integration (0026), activity-event migration (0027), restore and rollback runbooks (0039, 0052), alert rules and notification path (0065), firewall rules (0033), secrets provisioning (0067), and release-manifest tooling (0038).
- ToDo: [Clarify] Where "protected deployment configuration" lives (host-only files, a private repository, the infrastructure repository) and its format. Is there a committed template such as `deploy/env.example`?
- ToDo: [Clarify] "Health/metrics access rules" are partly an infrastructure-repository deliverable (external Nginx exclusions, ADR 0032). Assign ownership.
- ToDo: [Missing] No staging or pre-production environment is defined for validating these deliverables (ADR 0039, 0059).
