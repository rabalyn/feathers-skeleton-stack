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

Authentication uses a hybrid Feathers JWT model. The frontend keeps a short-lived access JWT in memory and supplies it for REST and WebSocket authentication. A longer-lived refresh credential is stored in an `HttpOnly`, `Secure`, `SameSite` cookie and is used only by a refresh endpoint. The frontend must refresh before expiry and re-authenticate the Feathers WebSocket connection after refresh or reconnect. The API must verify account validity on requests and define explicit logout, refresh-token revocation, and token-family invalidation behavior.

Refresh sessions are stored in a PostgreSQL `auth_sessions` table. Store only a hash of each refresh token, together with the user ID, token family, expiry, rotation and revocation timestamps, last-used timestamp, and limited user-agent/IP metadata. Rotate the refresh token on every refresh; reuse of an old token revokes the entire token family. An active session is a non-revoked, unexpired `auth_sessions` row. This definition is also used by the application statistics endpoint and Prometheus business metrics.

Because the access token is JavaScript-readable while it lives in memory, the frontend must still apply a strict Content Security Policy, avoid unsafe HTML rendering, keep dependencies updated, and never place secrets in the token payload. Cookie-based refresh requests require CSRF protection and explicit origin checks.

Initial abuse controls include login and password-reset rate limits by IP and account identifier, generic authentication failure messages, and structured security-event logging without passwords or tokens. Password reset and email verification may use development-only tokens during scaffolding; production release requires a real email delivery integration with expiring, single-use tokens.

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
├── compose.yaml             # Local/CI service topology
├── deploy/quadlet/           # Production systemd Quadlet units
├── Containerfile.api       # Backend image
├── Containerfile.web       # Frontend build/serve image
├── Containerfile.nginx     # Test-only reverse proxy image
├── nginx/                   # Test-only Nginx configuration
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

Production Nginx, certificates, DNS, and public routing are managed outside this repository. External Nginx proxies frontend requests to the versioned web container and API/WebSocket requests to the Feathers container. S3 remains private and is reachable only by the API and backup jobs. This repository produces the frontend image, the Feathers API image, and the S3-compatible object-storage service configuration for the production platform to deploy. The API connects to PgBouncer, not directly to PostgreSQL; PgBouncer owns the database connection pool and forwards pooled connections to PostgreSQL.

PostgreSQL and PgBouncer are operated as part of this deployment in production. PostgreSQL data uses dedicated persistent storage, while the API receives its connection details through environment variables or a secret mechanism, never from committed files.

## Container Strategy

### Rootless Podman

Rootless Podman is the target container runtime for local development, CI, and deployment where supported. Images should run as a non-root user internally whenever the base image and service allow it. Bind-mounted files and volumes must be checked for UID/GID compatibility in rootless environments.

`compose.yaml` defines local and CI services only and is usable with Podman Compose or an equivalent Compose-compatible tool. Production uses explicit systemd Quadlet units under `deploy/quadlet/`. The two definitions share image tags, environment variable names, health checks, and dependency contracts, but production lifecycle and secret handling remain systemd-specific. The local/CI topology should include:

- `db`: PostgreSQL with a named persistent volume and a health check.
- `pgbouncer`: PgBouncer between the API and PostgreSQL, with pool size and pool mode configured explicitly.
- `s3`: S3-compatible object storage service, such as MinIO, backed by a persistent named Podman volume in local and production profiles.
- `api`: FeathersJS API, dependent on database readiness rather than merely container startup.
- `web`: production frontend image containing static assets.
- `nginx`: local/test reverse proxy, static asset server, API router, and WebSocket endpoint.
- `logs`: Dozzle, connected to the rootless Podman API socket read-only.
- `alloy`: production host systemd service, reading Quadlet service logs from journald and forwarding them to Loki.
- `backup`: production-profile rootless backup container running `pg_dump` and restic, with `/srv/backups` mounted read-write and credential files mounted read-only.

Use separate profiles or Compose files for development and production where their needs differ. Production configuration must not rely on source-code bind mounts or development servers.

### PgBouncer

PgBouncer is a connection pooler, not a replacement for PostgreSQL. The API should use a pooler connection string with session pooling. This preserves compatibility with Knex prepared statements, session variables, advisory locks, and other session-dependent features, at the cost of more active PostgreSQL connections. Configure and monitor explicit application, PgBouncer, and PostgreSQL connection limits so session pooling cannot exhaust the database. PostgreSQL migrations and administrative tasks should use a separate direct administrative connection rather than the application pool.

The pooler must have its own health check and the API must fail clearly when the pooler is unavailable. PostgreSQL remains private to the Compose network; application containers should not need a direct database route.

### PostgreSQL operations

Production PostgreSQL uses a dedicated persistent host volume, separate from S3 and observability storage. Alert at 80% capacity and monitor I/O, connections, checkpoints, and WAL growth. Keep `fsync` and synchronous commit enabled and use PostgreSQL defaults until measured workload data justifies tuning. Initially perform major-version upgrades by creating a new database volume, restoring a tested dump, validating the database, and switching the deployment during a controlled maintenance window.

### S3-compatible object storage

The local and production Compose/Quadlet profiles should provide an S3-compatible object storage service using a rootless Podman container and persistent storage. MinIO is the initial candidate because it provides the S3 API needed by the application without requiring a third-party cloud account. The API should use the internal service name and port; the storage console and S3 port should be bound to localhost or a private network unless external access is explicitly required.

The S3 service is intended for:

- application object data such as uploaded documents, images, exports, and other binary files when the product requires them;
- generated application artifacts that are too large or unsuitable for PostgreSQL rows;
- local and CI staging of encrypted `pg_dump`/restic backup archives when testing backup and restore workflows.

It is not intended for users, sessions, activity records, relational business data, PostgreSQL's primary storage, Prometheus metrics, Loki logs, or Grafana's system data. Those belong in PostgreSQL or their dedicated services. In the initial application scaffold, the S3 bucket and object schema should only be added when an upload/export feature actually needs them.

The browser accesses object data through authorized Feathers API operations. The API validates ownership and permissions, then streams objects to or from S3. The S3 API and console are private and are not exposed through public Nginx routes. Presigned URLs can be introduced later if large-file bandwidth makes API-mediated transfers impractical.

In development and CI, the object-storage volume is disposable. In production, it is persistent application infrastructure and must have a volume backup or replication plan. The production S3 service is not a third-party dependency; it is deployed and operated with the rest of this stack. The S3 bucket names, endpoint, region, and path-style setting should be configurable through environment variables so tests can switch between local, CI, and production storage. Use an API-level object export or supported bucket sync to copy production objects to the NFS backup location; never copy a live MinIO data directory as if it were a consistent object backup.

Production database backups are stored on an NFS-mounted path accessible from the production host, not in the production S3 bucket. The NFS provider supplies snapshots for logical recovery, but this initial setup does not protect against NFS server, disk, or site loss. Use a dedicated NFS backup export mounted at a fixed path such as `/srv/backups` rather than sharing a general-purpose export. Replication or a second off-site copy is required before claiming host-disaster protection.

Configure the NFS source as a private DNS hostname and export path supplied by deployment configuration, for example `backup-nfs.internal:/exports/app-backups`; do not commit a real hostname or IP address. The systemd mount unit must be required by the backup timer, verify that `/srv/backups` is actually mounted before writing, and fail the backup clearly when NFS is unavailable. It must never fall back to an ordinary local directory. The backup container uses a dedicated numeric UID/GID that is authorized by the NFS export, rather than the deployment user's identity.

### Production orchestration

The initial production target is one Linux host using rootless Podman and systemd Quadlet. Quadlet unit files provide service ordering, restart behavior, environment-file integration, and startup after host reboots without requiring a full orchestration platform. External Nginx routes traffic to the API and frontend containers on that host; it does not expose S3. PostgreSQL, PgBouncer, S3-compatible storage, and the observability stack are all operated by this deployment.

The deployment should use immutable image tags, a controlled update procedure, health checks, and a documented rollback to the previous image tag. Move to multiple application hosts or a managed container platform when availability requirements exceed a single-host design.

### Nginx and local TLS

Nginx should be used in integration and end-to-end testing so browser routing, API proxying, WebSocket upgrades, and production-like headers are exercised. The repository owns a test-only Nginx configuration and image; production Nginx configuration and certificates remain external deliverables. Local development can still use direct Vite/Quasar hot reload for speed, but the containerized test profile should run the built web image behind the repository's test Nginx container.

For local HTTPS, use a locally trusted development CA such as `mkcert` and mount the generated certificate and key into the test Nginx container. This avoids browser warnings and keeps certificates out of version control. A simpler self-signed certificate is acceptable for non-browser smoke checks, but it requires explicit trust configuration in browser and test runners. Production certificates are provisioned externally and are never generated or stored by this repository.

### Stack log viewer

Application containers should write structured logs to standard output and standard error. Dozzle is the selected lightweight local/test log viewer and may also run privately in production for operator inspection. Expose the user-level Podman API socket to Dozzle as a read-only mount, restrict it to an operator-only network, and never expose it through public Nginx routes. Do not mount the host filesystem or a privileged system-wide socket merely to display logs. In production, host-installed Grafana Alloy reads Quadlet service output from journald and forwards it to the self-hosted Loki container; Alloy is the production log shipping path.

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

- Deploy immutable versioned images for the API and frontend assets, plus the persistent S3-compatible storage service, through the production host's Quadlet setup.
- Use externally managed Nginx, TLS certificates, DNS, and public routing. This deployment operates PostgreSQL, PostgreSQL storage, PgBouncer, S3-compatible storage, Grafana, Prometheus, Loki, and their persistent volumes.
- Keep PostgreSQL on a dedicated persistent volume with an 80% capacity alert; do not share its data volume with S3 or observability services.
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

- The initial target is a best-effort RPO of 48 hours and an RTO of 4 hours. RPO is the maximum acceptable data loss; RTO is the maximum acceptable time to restore service. The 48-hour figure reflects daily dumps, missed-run risk, and the absence of WAL archiving.
- The application team owns the backup jobs, encrypted storage, retention, restore procedure, and restore drills.
- Run one scheduled `pg_dump` backup each day, encrypt and deduplicate it with restic, and store the resulting repository on the production NFS mount. Retain daily PostgreSQL backups for 30 days.
- Run a separate daily S3 object export or synchronization alongside the database backup. Store it in a separate encrypted restic repository on NFS, using the protected operator-managed restic password initially. Retain 30 days of restic snapshots, including prior object states after deletions, and document restoration with object-count and representative-download verification.
- In local development and CI, point restic and object-storage integration tests at the local `s3` service. Production backup jobs must verify that the NFS mount is present and writable before creating or pruning backups.
- Treat an unavailable NFS mount as a backup failure, alert on it, and do not silently write to a local fallback path that could fill the production host.
- Document the NFS export, mount point, ownership, permissions, encryption key handling, and the NFS provider's snapshot or replication policy.
- Run the unattended rootless `backup` container with a dedicated numeric UID/GID. Use a fixed `/srv/backups` mount and store one restic repository password in a protected key file or rootless Podman secret mounted read-only. The single operator owns this password and must keep a separate offline recovery copy; losing it makes the encrypted backup repository unrecoverable. Test restore access whenever the host or backup configuration changes.
- Add continuous write-ahead-log archiving or point-in-time recovery when a 48-hour best-effort RPO becomes insufficient.
- Restrict who can read or delete backups, and keep backup credentials separate from application credentials.
- Test a full restore monthly. A backup is not considered valid until a restore produces a usable database and the result is recorded.
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
- Provide separate private health endpoints: `GET /health/live` only confirms that the API process is running, while `GET /health/ready` verifies required dependencies such as PgBouncer are reachable. Deployment and monitoring checks access both endpoints internally; external Nginx does not route them.
- Expose `GET /metrics` in Prometheus text format on the private monitoring network only. Prometheus and the API share an internal Podman network, the API port is not publicly bound, and external Nginx does not route `/metrics`. The endpoint must not contain passwords, tokens, email addresses, user IDs, or other high-cardinality personal data.
- Expose an authenticated `GET /stats` resource for application dashboards. It should return aggregate values such as total users, active users, session counts, activity counts, request/error totals, and time-bucketed trends. Protect it with a dedicated admin/observability permission and apply pagination or bounded time windows where details are requested.
- Keep `/metrics` and `/stats` separate: Prometheus metrics are machine-readable time series for alerting, while `/stats` is an authenticated application API for non-Grafana consumers. Grafana uses only Prometheus data and never connects directly to the application or database.
- Expose bounded business aggregates such as user, session, and activity counts as Prometheus metrics so Grafana can dashboard them through the Prometheus datasource.
- Prometheus scrapes the single `/metrics` endpoint every 15 seconds. Business metrics may use live aggregate queries initially because the expected load is fewer than 50 concurrent users, but queries must use indexed access paths, bounded time windows, database statement timeouts, and a strict query budget. Move to cached or summary-table aggregates if load or query cost becomes material.
- Track baseline metrics: request count, error count, latency, active connections, pool saturation, migration status, and process health.
- Use stable metric names and low-cardinality labels such as `service`, `route`, `method`, `status_code`, and `environment`. Never label metrics by user, email, session, request ID, or unrestricted URL values.
- Start with Grafana, Prometheus, Loki, and Dozzle as separate rootless services on the same production Linux host. Grafana provides dashboards and alert views, Prometheus stores and evaluates metrics, Loki stores searchable logs, and Dozzle provides private operator inspection. Run Grafana Alloy as a host systemd service that forwards journald logs. Reserve approximately 1 CPU and 1.5-2 GiB RAM and 10 GiB total disk for the containerized monitoring stack, with an alert at 80% disk usage and explicit per-container CPU, memory, and disk-retention limits so monitoring cannot consume all application capacity.
- Retain observability data for 14 days initially. Back up Grafana dashboards, alert rules, and configuration even when short-lived Prometheus and Loki data is not retained long term.
- Add OpenTelemetry and Grafana Tempo tracing when cross-service debugging becomes necessary; tracing is intentionally deferred from the first implementation.
- Define alerts for sustained API 5xx errors, high latency, failed readiness, PgBouncer pool exhaustion, PostgreSQL storage or connection pressure, backup failures, and certificate expiry in the external platform.
- Define an owner and response action for every alert. Review logs and alerts after the first releases and adjust thresholds based on observed normal behavior.
- Back up Grafana, Prometheus, and Loki configuration and any dashboards or alert rules that are not reproducibly defined in the repository.

## Configuration and Security

- Commit example configuration only, such as `.env.example`; do not commit credentials.
- For local development, generate random S3 and database credentials into an ignored `.env.local` file with mode `0600`, or create them as rootless Podman secrets. `.env.local` is a convenience for a single developer, not a committed or shared secret store.
- For the one-host production setup, keep credentials in rootless Podman secrets or protected systemd/Quadlet environment files owned by the deployment user. Limit file permissions, rotate credentials deliberately, and provide separate credentials for the API, backup jobs, monitoring, and local S3 administration.
- Do not add a dedicated secrets platform yet. Introduce one when multiple hosts, multiple operators, automated rotation, or compliance requirements make host-managed secrets insufficient.
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

- The actual private NFS hostname and export path are deployment-specific values supplied outside the repository.

These should become ADRs once implementation begins and the alternatives are understood.
