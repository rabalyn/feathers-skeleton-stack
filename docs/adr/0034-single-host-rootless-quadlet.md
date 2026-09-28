# 0034: Run production on one Linux host with rootless Podman and systemd Quadlet

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production); multi-host Deferred
- Source: [Technical architecture › Production orchestration, Runtime Topology, Production](../technical-architecture.md#production-orchestration)
- Related: [0001](0001-production-valkey.md), [0005](0005-production-log-path.md), [0035](0035-private-podman-networks.md), [0037](0037-compose-and-quadlet-definitions.md), [0040](0040-deferred-scale-out.md), [0050](0050-nfs-backup-mount.md)

## Context

Expected load is small (fewer than 50 concurrent users). A full orchestration platform would add operational cost without matching benefit.

## Decision

- The initial production target is one Linux host using rootless Podman and systemd Quadlet.
- User-level units run under a dedicated deployment user with configured subuid/subgid ranges and systemd lingering enabled, so services survive logout and reboot.
- Quadlet provides service ordering, restart behaviour, environment-file integration, and startup after reboot.
- Production services per the architecture: PostgreSQL, PgBouncer, S3-compatible storage, API, web, backup, Grafana, Prometheus, Loki, and Dozzle, plus host-installed Grafana Alloy for journald collection. Loki publishes only `127.0.0.1:3100:3100` for Alloy.
- PostgreSQL, PgBouncer, S3-compatible storage, and the observability stack are operated by this deployment.

## Consequences

- Simple operations with systemd-native tooling.
- The host is a single point of failure for the application and its monitoring.
- Rootless constraints (UID mapping, user-level systemd) apply to every service.

## ToDos

- ToDo: [Contradiction] The service inventory omits Valkey, which ADR 0001 makes a required production service. The "Production" environment list also omits Valkey, Dozzle, and backup.
- ToDo: [Missing] One-shot units absent from the inventory: migrations (ADR 0012), daily maintenance (ADR 0028), bootstrap (ADR 0059), restore drill (ADR 0052), and the exporters needed for alerts (ADR 0035, 0065).
- ToDo: [Contradiction] The runtime topology says this repository produces images and storage configuration "for the production platform to deploy", implying a separate deployer. Elsewhere this deployment operates the whole stack through its own Quadlet units. Who performs deployments?
- ToDo: [Verify] Rootless user-level systemd units can't declare real dependencies (`Requires=`/`After=`) on system-level units such as the NFS `.mount` unit or the host Alloy service. That affects ADR 0050's "required before the whole production stack starts".
- ToDo: [Verify] Set the Quadlet log driver explicitly. With `passthrough`, `podman logs` (and therefore Dozzle) can't read container output; with `journald`, both Alloy and Dozzle work (ADR 0005).
- ToDo: [Missing] Host sizing (CPU, RAM, disk). Only the monitoring budget is defined (ADR 0064).
- ToDo: [Clarify] Host OS and minimum Podman version (Quadlet features vary by version), and who installs host packages (Podman, Alloy, NFS client).
- ToDo: [Clarify] Restart policies, start ordering, and health-gated dependencies, including Valkey.
- ToDo: [Clarify] Whether `podman auto-update` is explicitly disabled, given immutable tags.
- ToDo: [Missing] No availability target (SLO) is defined, so "when availability requirements exceed a single-host design" can't be evaluated.
