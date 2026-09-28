# Architecture Decision Records

This directory records every architecture decision from [technical-architecture.md](../technical-architecture.md), one decision per ADR. ADRs 0001–0007 resolve specific contradictions. ADRs 0008–0070 capture the rest of the architecture document.

## ADR fields

Each ADR has `Status`, `Date`, `Scope`, `Source`, and `Related` fields, followed by `Context`, `Decision`, `Consequences`, and `ToDos` sections.

- **Scope** follows [ADR 0007](0007-requirement-classification.md): `Required (v1)`, `Required (production)` / `Required (before first production release)`, `Conditional`, or `Deferred`.
- **Source** links the section of the architecture document the decision was taken from.

## Reviewing open points

Every open point starts with `ToDo:` and one of these tags:

| Tag | Meaning |
| --- | --- |
| `[Contradiction]` | Two statements in the architecture (or between ADRs) conflict. One must change. |
| `[Clarify]` | The statement is vague or leaves a choice open. |
| `[Missing]` | Something another decision depends on is not decided at all. |
| `[Verify]` | A factual assumption (versions, upstream project status, tool behaviour) that should be checked against current sources. |

List them all with:

```sh
grep -rn "ToDo:" docs/adr/
grep -rn "ToDo: \[Contradiction\]" docs/adr/
```

ToDo: review the ADRs as a set and reconcile any remaining open questions before implementation begins.

## Index

### Resolved contradictions (initial set)

- [0001 - Include Valkey in the production deployment](0001-production-valkey.md)
- [0002 - Treat object storage as a v1 capability with feature-gated bucket adoption](0002-object-storage-v1.md)
- [0003 - Separate direct local development from containerized integration testing](0003-local-vs-containerized-frontend.md)
- [0004 - Keep the repo boundary separate from the external infrastructure repo](0004-repo-vs-infrastructure-boundary.md)
- [0005 - Use Alloy/Loki for production logs and reserve Dozzle for private operator access](0005-production-log-path.md)
- [0006 - Keep NFS backups separate from application object storage](0006-backup-storage-boundary.md)
- [0007 - Classify baseline requirements versus future enhancements](0007-requirement-classification.md)

### Platform and data layer

- [0008 - Use FeathersJS v5 with TypeScript for the API](0008-feathersjs-v5-api.md)
- [0009 - Pin Node.js 22 LTS and pnpm 10 across all environments](0009-node-and-pnpm-versions.md)
- [0010 - Use TypeScript strict mode with additional index-access checks](0010-typescript-strict-mode.md)
- [0011 - Use PostgreSQL 17 as the system of record](0011-postgresql-17.md)
- [0012 - Use the Feathers Knex adapter and explicit, deployment-time migrations](0012-knex-adapter-and-migrations.md)
- [0013 - Use TypeBox schemas and enforce validation and authorization at the service boundary](0013-typebox-validation-boundary.md)
- [0014 - Put PgBouncer in session pooling mode between the API and PostgreSQL](0014-pgbouncer-session-pooling.md)
- [0015 - Separate database roles and connection paths for API, migrations, and backups](0015-database-roles-and-connection-paths.md)

### Workspace and repository

- [0016 - Use a pnpm workspace monorepo without a task orchestrator](0016-pnpm-workspace-monorepo.md)
- [0017 - Share Feathers service contracts in `packages/contracts`; defer OpenAPI](0017-shared-contracts-package.md)
- [0018 - Target repository layout](0018-repository-layout.md)

### Domain and authorization

- [0019 - Single shared application context without multi-tenancy in v1](0019-single-app-context.md)
- [0020 - v1 domain model of shared-app users plus a basic document/profile object](0020-v1-domain-model.md)
- [0021 - Role-based authorization with `feathers-casl` (owner, admin, user)](0021-casl-role-authorization.md)

### Authentication and activity

- [0022 - Use Feathers local email/password authentication](0022-local-password-authentication.md)
- [0023 - Hybrid JWT authentication with in-memory access tokens and an HttpOnly refresh cookie](0023-hybrid-jwt-refresh-cookie.md)
- [0024 - Store rotating refresh sessions in PostgreSQL `auth_sessions`](0024-refresh-session-storage.md)
- [0025 - Valkey-backed, fail-closed rate limits for login and password reset](0025-authentication-rate-limiting.md)
- [0026 - Require real email delivery for password reset and verification before production](0026-password-reset-and-email-verification.md)
- [0027 - Record minimal, successful activity events with 90-day retention](0027-activity-audit-events.md)
- [0028 - Daily maintenance job for session and activity-event cleanup](0028-daily-maintenance-job.md)

### Frontend

- [0029 - Build the frontend with Vue 3, Quasar (Vite), and `feathers-pinia`](0029-vue-quasar-feathers-pinia.md)
- [0030 - Ship the frontend as a static-asset container image](0030-frontend-static-image.md)
- [0031 - Frontend security baseline (CSP, safe rendering, dependency hygiene)](0031-frontend-security-baseline.md)

### Runtime topology and releases

- [0032 - Route production traffic through external Nginx to loopback-published API and web containers](0032-external-nginx-ingress.md)
- [0033 - Expose only HTTPS (and optional HTTP) publicly on the production host](0033-host-firewall.md)
- [0034 - Run production on one Linux host with rootless Podman and systemd Quadlet](0034-single-host-rootless-quadlet.md)
- [0035 - Segment production containers into `backend`, `object`, and `monitoring` networks](0035-private-podman-networks.md)
- [0036 - Use rootless Podman everywhere and run images as non-root users](0036-rootless-non-root-containers.md)
- [0037 - Define local/CI topology in `compose.yaml` and production in Quadlet units](0037-compose-and-quadlet-definitions.md)
- [0038 - Build production images on the host from versioned release sources; no registry initially](0038-host-built-images-no-registry.md)
- [0039 - Release procedure of backup, migrate, validate, switch, with image-tag rollback](0039-release-procedure-and-rollback.md)
- [0040 - Defer scale-out (separate database/Valkey nodes, multiple hosts)](0040-deferred-scale-out.md)

### Database operations

- [0041 - PostgreSQL operations baseline (storage, tuning, major upgrades)](0041-postgresql-operations.md)
- [0042 - Expand-and-contract migrations; roll back code, not schema](0042-migration-and-rollback-policy.md)

### Object storage

- [0043 - Self-host S3-compatible object storage (MinIO as initial candidate)](0043-minio-object-storage.md)
- [0044 - Mediate all browser object access through the API; defer presigned URLs](0044-api-mediated-object-access.md)
- [0045 - Limit uploads to 50 MiB and an explicit type allowlist, streamed without buffering](0045-upload-validation-limits.md)
- [0046 - Separate buckets for uploads and exports; backup staging bucket only in local/CI](0046-bucket-layout.md)

### Backup and restore

- [0047 - Best-effort RPO of 48 hours and RTO of 4 hours; defer WAL archiving](0047-backup-objectives.md)
- [0048 - Daily `pg_dump` encrypted with restic onto NFS, retained 30 days](0048-postgresql-backup-restic-nfs.md)
- [0049 - Coordinated daily object export with a write pause, snapshotted by restic](0049-coordinated-object-backup.md)
- [0050 - Dedicated, mandatory NFS mount at `/srv/backups` with no local fallback](0050-nfs-backup-mount.md)
- [0051 - Run backups in an isolated, unattended rootless container with separate credentials](0051-backup-container-isolation.md)
- [0052 - Monthly full restore drills and CI restore tests define backup validity](0052-restore-drills.md)

### Development, CI, and testing

- [0053 - Local development environment, ports, and explicit seeding](0053-local-development-environment.md)
- [0054 - Repository-owned, test-only Nginx for integration and end-to-end tests](0054-test-only-nginx.md)
- [0055 - Use `mkcert` for local HTTPS in the test Nginx profile](0055-mkcert-local-https.md)
- [0056 - GitHub Actions CI building the deployment Containerfiles and testing against an ephemeral stack](0056-github-actions-ci.md)
- [0057 - Split tests into unit, integration, and end-to-end layers with isolated data](0057-test-layers-and-isolation.md)
- [0058 - Playwright end-to-end tests against the built frontend behind test Nginx](0058-playwright-e2e.md)

### Operations and observability

- [0059 - Create production initial data only through a manual, one-time bootstrap command](0059-production-bootstrap.md)
- [0060 - Separate private liveness and readiness endpoints](0060-health-endpoints.md)
- [0061 - Structured JSON logs to stdout without secrets](0061-structured-logging.md)
- [0062 - Private Prometheus `/metrics` endpoint including bounded business aggregates](0062-prometheus-metrics.md)
- [0063 - Authenticated `/stats` API for application dashboards, separate from `/metrics`](0063-stats-endpoint.md)
- [0064 - Self-hosted Grafana, Prometheus, Loki, Alloy, and Dozzle on the production host with fixed budgets](0064-observability-stack.md)
- [0065 - Baseline alert set with an owner and response action per alert](0065-alerting.md)
- [0066 - Defer distributed tracing (OpenTelemetry, Grafana Tempo)](0066-deferred-tracing.md)

### Configuration, security, and documentation

- [0067 - Host-managed secrets and environment-based configuration; no secrets platform yet](0067-secrets-and-configuration.md)
- [0068 - API security baseline (origins, least privilege, consistent hooks, updates)](0068-api-security-baseline.md)
- [0069 - Documentation convention (README, architecture overview, ADRs)](0069-documentation-convention.md)
- [0070 - Keep deployment-specific values outside the repository; define pre-production deliverables](0070-deployment-specific-configuration.md)
