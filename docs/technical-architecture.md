# Technical Architecture

**Status:** Proposed  
**Last updated:** 2026-09-12

## Purpose

This document records the initial technical direction for this repository. It is intentionally a living document: decisions should be updated here when implementation choices change, with the reason and date captured in the relevant section.

## Goals

- Provide an API backend using FeathersJS.
- Use PostgreSQL as the system of record.
- Provide a Vue 3 frontend using Quasar and `feathers-pinia`.
- Make local development and deployment reproducible with rootless Podman.
- Run automated tests in an environment that is close to deployment.

## Proposed Stack

### Backend

- Node.js with FeathersJS v5.
- TypeScript for application code, configuration, and shared contracts.
- PostgreSQL.
- PgBouncer in front of PostgreSQL for connection pooling.
- Feathers local authentication with email/password (`@feathersjs/authentication-local`), with password hashes stored by the local strategy and never returned by services.
- Feathers database services using the Knex adapter (`@feathersjs/knex`) unless a later decision requires another adapter.
- Migrations managed by the database layer and executed explicitly during deployment.
- TypeBox for request, response, query, and data schemas, with generated TypeScript types where practical.
- API validation and authorization at the service boundary; database constraints remain the final integrity boundary.

### Frontend

- Vue 3.
- Quasar Framework with its Vite-based build.
- `feathers-pinia` for Feathers service state, querying, pagination, and real-time synchronization where needed.
- A generated production bundle of static assets.

### Workspace and package management

This repository will use a pnpm workspace. A monorepo is a single repository containing multiple related packages or applications that can be developed, tested, and versioned together. Here, the API and web applications live under `apps/`, while genuinely shared code can live under `packages/`.

pnpm provides workspace dependency linking, a shared lockfile, and efficient package storage without requiring a separate monorepo orchestration product. Start with pnpm workspace scripts. Add a task orchestrator such as Turborepo or Nx only if build caching or task graphs become a demonstrated need; it is not required for the initial project.

The initial API contract will use Feathers' typed client directly. Feathers service interfaces, TypeBox schemas, and inferred TypeScript types should live in a shared `packages/contracts` package imported by both the API and frontend. OpenAPI client generation is deferred until an external consumer or language requires it.

## Repository Layout

The implementation should grow toward this structure:

```text
.
├── apps/
│   ├── api/                 # FeathersJS application
│   └── web/                 # Vue + Quasar application
├── packages/                # Optional shared types and utilities
├── docs/                    # Architecture and decision documents
├── pnpm-workspace.yaml      # Workspace package boundaries
├── compose.yaml             # Local/test service topology
├── Containerfile.api       # Backend image
├── Containerfile.web       # Frontend build/serve image
└── README.md               # Project entry point and quick start
```

The exact workspace layout is open until the first application scaffold is added. Shared packages should only be introduced when there is a real cross-application contract to share, such as generated API types.

## Runtime Topology

In production, the intended topology is:

```text
Browser --HTTPS--> externally managed Nginx -> frontend assets
                                      \\-> Feathers API --pool--> PgBouncer -> PostgreSQL
                                      \\-> WebSocket upgrade
```

Production Nginx, certificates, DNS, and public routing are managed outside this repository. This repository produces the frontend assets/image and the Feathers API image for that platform to deploy. The API connects to PgBouncer, not directly to PostgreSQL; PgBouncer owns the database connection pool and forwards pooled connections to PostgreSQL.

PostgreSQL and its production storage are infrastructure concerns. The API should receive its connection details through environment variables or a secret mechanism, never from committed files.

## Container Strategy

### Rootless Podman

Rootless Podman is the target container runtime for local development, CI, and deployment where supported. Images should run as a non-root user internally whenever the base image and service allow it. Bind-mounted files and volumes must be checked for UID/GID compatibility in rootless environments.

The service topology should be described once in `compose.yaml` and be usable with Podman Compose or an equivalent Compose-compatible tool. The topology should include:

- `db`: PostgreSQL with a named persistent volume and a health check.
- `pgbouncer`: PgBouncer between the API and PostgreSQL, with pool size and pool mode configured explicitly.
- `api`: FeathersJS API, dependent on database readiness rather than merely container startup.
- `web`: production frontend image containing static assets.
- `nginx`: local/test reverse proxy, static asset server, API router, and WebSocket endpoint.
- `logs`: Dozzle, connected to the rootless Podman API socket read-only.

Use separate profiles or Compose files for development and production where their needs differ. Production configuration must not rely on source-code bind mounts or development servers.

### PgBouncer

PgBouncer is a connection pooler, not a replacement for PostgreSQL. The API should use a pooler connection string and a pool mode appropriate to the application. Transaction pooling is the default candidate for stateless Feathers requests, but it must be checked against session-specific features such as prepared statements, advisory locks, and session variables. PostgreSQL migrations should use a direct administrative connection or a separately configured session-pooling path when required.

The pooler must have its own health check and the API must fail clearly when the pooler is unavailable. PostgreSQL remains private to the Compose network; application containers should not need a direct database route.

### Production orchestration

The initial production target is one Linux host using rootless Podman and systemd Quadlet. Quadlet unit files provide service ordering, restart behavior, environment-file integration, and startup after host reboots without requiring a full orchestration platform. External Nginx routes traffic to the API and frontend deployment on that host.

The deployment should use immutable image tags, a controlled update procedure, health checks, and a documented rollback to the previous image tag. Move to multiple application hosts or a managed container platform when availability requirements exceed a single-host design.

### Nginx and local TLS

Nginx should be used in integration and end-to-end testing so browser routing, API proxying, WebSocket upgrades, and production-like headers are exercised. Nginx configuration and certificates are not production deliverables of this repository. Local development can still use direct Vite/Quasar hot reload for speed, but the containerized test profile should run the built web image behind a test Nginx container.

For local HTTPS, use a locally trusted development CA such as `mkcert` and mount the generated certificate and key into the test Nginx container. This avoids browser warnings and keeps certificates out of version control. A simpler self-signed certificate is acceptable for non-browser smoke checks, but it requires explicit trust configuration in browser and test runners. Production certificates are provisioned externally and are never generated or stored by this repository.

### Stack log viewer

Application containers should write structured logs to standard output and standard error. Dozzle is the selected lightweight local/test log viewer. In rootless Podman, expose the user-level Podman API socket to Dozzle as a read-only mount, and protect the viewer behind Nginx or local-only port binding. Do not mount the host filesystem or a privileged system-wide socket merely to display logs. Production log collection remains an infrastructure responsibility.

### Frontend Containerization Recommendation

Frontend projects are commonly containerized for CI and deployment, but the resulting production image generally contains static assets rather than a Node.js development server. The recommended flow is:

1. Install dependencies and run lint, type checks, unit tests, and the production build in a Node-based build stage.
2. Copy the generated Quasar assets into a minimal static web-server image.
3. Serve that image in deployment and route API/WebSocket requests through the reverse proxy.

This gives deployment a reproducible artifact and makes the build environment consistent with CI. It does not require developers to run the frontend in a container for every edit; a local `quasar dev` process can be used for faster feedback, while the containerized path remains the deployment and integration-test path.

## Environments

### Development

- Run PostgreSQL in rootless Podman.
- Run PgBouncer, Nginx, and the log viewer in the containerized development/test profile.
- Run the API and frontend either locally for fast reload or through the development Compose profile.
- Use the Nginx profile for browser and WebSocket integration testing; use `mkcert` certificates when HTTPS behavior matters.
- Use a non-production database and credentials.
- Keep migrations and seed data repeatable.

### CI

CI should build the API, web, and Nginx images and run checks against an ephemeral PostgreSQL and PgBouncer stack. At minimum:

- backend unit and service tests;
- frontend unit/component tests;
- linting and type checking;
- database migration tests against PostgreSQL;
- an integration or smoke test through Nginx using the built API and web artifacts;
- a WebSocket upgrade check through Nginx.

The CI image build should be the same Containerfile path used for deployment. This catches missing files, incorrect runtime configuration, and frontend routing issues before release.

### Production

- Deploy immutable versioned images for the API and frontend assets through the external production platform.
- Use externally managed Nginx, TLS certificates, DNS, PostgreSQL, PgBouncer, storage, and log collection.
- Apply migrations as a controlled release step before enabling code that depends on them.
- Pass configuration through environment variables or a secret store.
- Add health and readiness endpoints, structured logs, and basic metrics before the first production release.

## Testing and Quality Gates

Tests should be split by feedback speed:

- unit tests for services, hooks, validators, stores, and components;
- integration tests for Feathers services against real PostgreSQL;
- end-to-end smoke tests against the built web and API containers.

A test should not depend on a developer's local database. CI should create its own database and clean it up after the run. Test data must be isolated per run.

### Recommended CI and browser testing

Use GitHub Actions as the initial CI provider. It is well integrated with GitHub repositories, supports Linux runners that can install Node.js and pnpm, and can run service containers for PostgreSQL and the local test stack. Keep the workflow small at first: install with the frozen pnpm lockfile, run linting and type checking, run unit/integration tests, build the images, and run the end-to-end job.

Use Playwright for browser end-to-end tests. It supports Chromium, Firefox, and WebKit, has good TypeScript support, automatically waits for browser conditions, and provides useful traces and screenshots when a test fails. The first end-to-end suite should cover login, one authenticated read/write workflow, logout, API routing through Nginx, and a WebSocket or real-time update if the application uses one. Run it against the built frontend behind the test Nginx container rather than against the development server.

## Data Operations Policies

These policies define what must be decided before production, rather than prescribing a specific cloud provider.

### Backup policy

- The initial target is an RPO of 24 hours and an RTO of 4 hours. RPO is the maximum acceptable data loss; RTO is the maximum acceptable time to restore service.
- The application team owns the backup jobs, encrypted off-host storage, retention, restore procedure, and restore drills.
- Take automated PostgreSQL backups and retain daily backups for a defined period. Add continuous write-ahead-log archiving or point-in-time recovery when the 24-hour RPO becomes insufficient.
- Restrict who can read or delete backups, and keep backup credentials separate from application credentials.
- Test a restore on a scheduled basis. A backup is not considered valid until a restore produces a usable database and the result is recorded.
- Document who can start a restore, where the restored database is created, how application access is paused, and how the restored version is verified.

### Migration and rollback policy

- Every schema change is a reviewed, versioned migration committed with the application code.
- Run migrations against a disposable PostgreSQL database in CI before release.
- Prefer expand-and-contract changes: add the new schema first, deploy code that can work with both forms, backfill data, then remove the old schema in a later release.
- Keep production migrations small and transactional where PostgreSQL permits it. Avoid long locks during normal traffic.
- Do not rely on an automatic `down` migration as the primary production rollback mechanism. Rolling application code back while keeping a newer schema is usually safer than reversing a destructive schema change.
- For a failed migration, stop the release, inspect whether the migration committed, restore from backup or point-in-time recovery when data was changed incorrectly, and deploy a forward fix when possible.
- Before each release, record the migration version, backup/PITR position, application image version, and the tested recovery procedure.

### Observability policy

- Emit structured JSON logs to standard output with timestamp, level, service, request ID, user ID where appropriate, route, status, duration, and error details. Never log passwords, tokens, or sensitive request bodies.
- Provide separate health endpoints: `GET /health/live` only confirms that the API process is running, while `GET /health/ready` verifies required dependencies such as PgBouncer are reachable. Readiness may return dependency details to internal callers, but public failure responses should not disclose connection information.
- Expose `GET /metrics` in Prometheus text format. This endpoint is for the Prometheus scraper, should be reachable only from the internal monitoring network or with dedicated scrape credentials, and must not contain passwords, tokens, email addresses, user IDs, or other high-cardinality personal data.
- Expose an authenticated `GET /stats` resource for application dashboards. It should return aggregate values such as total users, active users, session counts, activity counts, request/error totals, and time-bucketed trends. Protect it with a dedicated admin/observability permission and apply pagination or bounded time windows where details are requested.
- Keep `/metrics` and `/stats` separate: Prometheus metrics are machine-readable time series for alerting, while `/stats` is an application API for dashboard cards and business aggregates. Do not make Grafana query the primary application database directly.
- Track baseline metrics: request count, error count, latency, active connections, pool saturation, migration status, and process health.
- Use stable metric names and low-cardinality labels such as `service`, `route`, `method`, `status_code`, and `environment`. Never label metrics by user, email, session, request ID, or unrestricted URL values.
- Start with a self-hosted Grafana, Prometheus, and Loki stack. Grafana provides dashboards and alert views, Prometheus stores and evaluates metrics, and Loki stores searchable logs.
- Add OpenTelemetry and Grafana Tempo tracing when cross-service debugging becomes necessary; tracing is intentionally deferred from the first implementation.
- Define alerts for sustained API 5xx errors, high latency, failed readiness, PgBouncer pool exhaustion, PostgreSQL storage or connection pressure, backup failures, and certificate expiry in the external platform.
- Define an owner and response action for every alert. Review logs and alerts after the first releases and adjust thresholds based on observed normal behavior.
- Back up Grafana, Prometheus, and Loki configuration and any dashboards or alert rules that are not reproducibly defined in the repository.

## Configuration and Security

- Commit example configuration only, such as `.env.example`; do not commit credentials.
- Validate required environment variables at application startup.
- Use least-privilege database credentials for the API.
- Configure CORS and allowed WebSocket origins explicitly.
- Apply authentication and authorization consistently in Feathers hooks and services.
- Keep dependency updates and image base updates part of regular maintenance.

## Documentation Convention

This repository uses the following convention:

- `README.md`: what the project is, prerequisites, quick start, common commands, and links into `docs/`.
- `docs/technical-architecture.md`: the current system shape and operational guidance.
- `docs/adr/NNNN-short-title.md`: one decision per Architecture Decision Record when a choice has meaningful alternatives or long-term impact.
- Code comments: only explain non-obvious implementation details; do not duplicate this document.

For an ADR, include `Status`, `Context`, `Decision`, and `Consequences`. Keep this architecture document focused on the current intended system, and link to ADRs when a decision needs historical context.

## Open Decisions

- Exact retention periods for PostgreSQL backups and observability data.
- The concrete backup tooling and storage destination on the production host.
- The concrete Grafana, Prometheus, and Loki deployment layout and resource limits.
- When availability requirements justify multiple application hosts or a managed container platform.

These should become ADRs once implementation begins and the alternatives are understood.
