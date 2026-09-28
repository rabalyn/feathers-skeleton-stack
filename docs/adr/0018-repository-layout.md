# 0018: Target repository layout

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Repository Layout](../technical-architecture.md#repository-layout)
- Related: [0016](0016-pnpm-workspace-monorepo.md), [0017](0017-shared-contracts-package.md), [0037](0037-compose-and-quadlet-definitions.md), [0070](0070-deployment-specific-configuration.md)

## Context

Contributors need a predictable place for application code, container definitions, deployment units, and documentation.

## Decision

The implementation grows toward this structure:

```text
.
├── apps/
│   ├── api/                 # FeathersJS application
│   └── web/                 # Vue + Quasar application
├── packages/                # Shared types and utilities
├── docs/                    # Architecture and decision documents
├── pnpm-workspace.yaml      # Workspace package boundaries
├── compose.yaml             # Local/CI service topology
├── deploy/quadlet/          # Production systemd Quadlet units
├── Containerfile.api        # Backend image
├── Containerfile.web        # Frontend build/serve image
├── Containerfile.nginx      # Test-only reverse proxy image
├── nginx/                   # Test-only Nginx configuration
└── README.md                # Project entry point and quick start
```

Shared packages are introduced only for real cross-application contracts.

## Consequences

- Container and deployment definitions sit at the repository root, next to the workspace.
- Test-only Nginx assets are clearly separate from production ingress, which lives in the infrastructure repository (ADR 0004).

## ToDos

- ToDo: [Contradiction] The tree fixes exact file names, while the architecture also says "the exact workspace layout is open until the first application scaffold is added". Mark which parts are binding.
- ToDo: [Missing] Items required by other decisions but absent from the tree: backup container Containerfile and scripts (ADR 0051), PgBouncer configuration/image (ADR 0014), Valkey configuration (ADR 0001), Prometheus/Grafana/Loki/Alloy configuration (ADR 0064), the NFS mount unit (ADR 0050), migration/maintenance/bootstrap job units (ADR 0012, 0028, 0059), `.env.example` (ADR 0067), `.github/workflows/` (ADR 0056), Playwright tests (ADR 0058), `mkcert` helper scripts (ADR 0055), and runbooks for restore, rollback, and bootstrap.
- ToDo: [Clarify] `Containerfile.web` is described as a "build/serve image" but no static server is chosen (ADR 0030).
- ToDo: [Clarify] Whether host-level configuration (Alloy, NFS mount unit, firewall) lives in this repository or the infrastructure repository (ADR 0004).
