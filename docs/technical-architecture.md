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
- Use Node.js 22 LTS for local development, CI, and production images. Pin pnpm 10 through the root `package.json` `packageManager` field so the workspace uses one package-manager version everywhere.
- TypeScript for application code, configuration, and shared contracts.
- PostgreSQL.
- Valkey for shared authentication rate-limit state from the initial deployment; it is not a source of business data.
- PgBouncer in front of PostgreSQL for connection pooling.
- Feathers local authentication with email/password (`@feathersjs/authentication-local`), with password hashes stored by the local strategy and never returned by services.
- Feathers database services using the Knex adapter (`@feathersjs/knex`) unless a later decision requires another adapter.
- Migrations managed by the database layer and executed explicitly during deployment.
- TypeBox for request, response, query, and data schemas, with generated TypeScript types where practical.
- API validation and authorization at the service boundary; database constraints remain the final integrity boundary.
- Pin PostgreSQL 17 for local, CI, and production images. Apply minor updates regularly and treat major-version upgrades as the documented dump-and-restore operation.
- Use TypeScript strict mode with `noImplicitAny` and `noUncheckedIndexedAccess` enabled.

Authentication uses a hybrid Feathers JWT model. The frontend keeps a 5-minute access JWT in memory and supplies it for REST and WebSocket authentication. It refreshes the access token 60 seconds before expiry. A 30-day refresh credential is stored in an `HttpOnly; Secure; SameSite=Strict; Path=/authentication/refresh` cookie and is used only by the `/authentication/refresh` endpoint. The refresh handler validates the `Origin` header against the configured frontend origin. The frontend must re-authenticate the Feathers WebSocket connection after refresh or reconnect. Normal logout revokes only the current refresh session; a separate logout-all operation revokes all sessions for the user. If refresh fails, clear authentication state, close the WebSocket, and redirect to login. The API must verify account validity on requests and define explicit refresh-token revocation and token-family invalidation behavior.

Refresh sessions are stored in a PostgreSQL `auth_sessions` table. Store only a hash of each refresh token, together with the user ID, token family, expiry, rotation and revocation timestamps, last-used timestamp, and limited user-agent/IP metadata. Add indexes for token lookup, user/session statistics, and expiry cleanup. Rotate the refresh token on every refresh; reuse of an old token revokes the entire token family. Coordinate browser refreshes across tabs with a client-side lock or `BroadcastChannel` so ordinary races do not look like token theft; server-side reuse detection remains authoritative. Allow unlimited sessions per user initially, run a daily cleanup for expired/revoked rows, and revoke all sessions when a password changes or an account is disabled. An active session is a non-revoked, unexpired `auth_sessions` row. This definition is also used by the application statistics endpoint and Prometheus business metrics.

Application activity is recorded as explicit, successful audit events for meaningful domain operations such as login, upload, create/update/delete, and export. Token refreshes and ordinary read/poll requests are not activity events. Retain audit events for 90 days and clean them up with the daily maintenance job. Store only minimal metadata such as user ID, action, service/resource type, success, timestamp, request ID, and coarse result metadata; never persist request bodies, object contents, tokens, or other sensitive values. Active users are users with at least one successful authenticated activity event in the selected period. Activity metrics use only a fixed allowlist of action and service labels; they never include user IDs, email addresses, object keys, or arbitrary label values.

Because the access token is JavaScript-readable while it lives in memory, the frontend must still apply a strict Content Security Policy, avoid unsafe HTML rendering, keep dependencies updated, and never place secrets in the token payload. Cookie-based refresh requests require CSRF protection and explicit origin checks.

Initial abuse controls use Valkey-backed login and password-reset rate limits by IP and account identifier, generic authentication failure messages, and structured security-event logging without passwords or tokens. Use a default of 3 failed login attempts per 10 minutes per account or IP, a password-reset limit of 3 requests per hour per account or IP, and a 15-minute rate-limit cooldown. If Valkey is unavailable, reject affected authentication and password-reset attempts rather than fail open. Password reset and email verification may use development-only tokens during scaffolding; production release requires a real email delivery integration with expiring, single-use tokens.

### Frontend

- Vue 3.
- Quasar Framework with its Vite-based build.
- `feathers-pinia` for Feathers service state, querying, pagination, and real-time synchronization where needed.
- A generated production bundle of static assets.

### Authorization model

The initial shared-app role model is `owner + admin + user`, implemented with `feathers-casl` for explicit service-level authorization. This gives a clean permission boundary without introducing multi-tenancy in v1. The first app should assume a single shared app context and only add tenant boundaries when an actual product need appears.

### Workspace and package management

This repository will use a pnpm workspace. A monorepo is a single repository containing multiple related packages or applications that can be developed, tested, and versioned together. Here, the API and web applications live under `apps/`, while genuinely shared code can live under `packages/`.

pnpm provides workspace dependency linking, a shared lockfile, and efficient package storage without requiring a separate monorepo orchestration product. Start with pnpm workspace scripts. Add a task orchestrator such as Turborepo or Nx only if build caching or task graphs become a demonstrated need; it is not required for the initial project.

The initial API contract will use Feathers' typed client directly. Feathers service interfaces, TypeBox schemas, and inferred TypeScript types should live in a shared `packages/contracts` package imported by both the API and frontend. OpenAPI client generation is deferred until an external consumer or language requires it.

## Initial v1 domain model

The simplest first domain model is a shared-app user plus a basic document/profile object. This gives the app a real CRUD surface, supports upload and export permissions, and does not require tenant boundaries or a larger domain model before the first scaffold is working.

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

Production Nginx, certificates, DNS, and public routing are managed in a separate infrastructure repository but run on the same initial production host. On that host, Feathers listens on `0.0.0.0:3000` inside its container and Quadlet publishes it only as `127.0.0.1:3000:3000`; the web server listens on `0.0.0.0:8080` inside its container and is published only as `127.0.0.1:8080:8080`. External Nginx proxies frontend requests to the web loopback upstream and REST/WebSocket requests to the API loopback upstream. The WebSocket route uses HTTP/1.1 upgrade headers and an explicit idle timeout. S3 remains private and is reachable only by the API and backup jobs. This repository produces the frontend image, the Feathers API image, and the S3-compatible object-storage service configuration for the production platform to deploy. The API connects to PgBouncer, not directly to PostgreSQL; PgBouncer owns the database connection pool and forwards pooled connections to PostgreSQL.

The production host firewall exposes HTTPS publicly, optionally HTTP for redirects or certificate issuance, and restricts SSH to an approved management source. API, web, Loki, Dozzle, S3, PostgreSQL, PgBouncer, Prometheus, and Grafana ports remain loopback-only or private-network-only.

PostgreSQL, PgBouncer, and Valkey are operated as part of this deployment in production. PostgreSQL data uses dedicated persistent storage, while the API receives its connection details through environment variables or a secret mechanism, never from committed files. Valkey runs on the same host initially and is used for shared authentication rate-limit state; it does not store business data and does not require persistence for this initial use. A separate PostgreSQL node and a Valkey node are future scaling options.

## Container Strategy

### Rootless Podman

Rootless Podman is the target container runtime for local development, CI, and deployment where supported. Images should run as a non-root user internally whenever the base image and service allow it. Bind-mounted files and volumes must be checked for UID/GID compatibility in rootless environments.

`compose.yaml` defines local and CI services only and is usable with Podman Compose or an equivalent Compose-compatible tool. Production uses explicit systemd Quadlet units under `deploy/quadlet/`. The two definitions share image tags, environment variable names, health checks, and dependency contracts, but production lifecycle and secret handling remain systemd-specific. The local/CI topology should include:

- `db`: PostgreSQL with a named persistent volume and a health check.
- `pgbouncer`: PgBouncer between the API and PostgreSQL, with pool size and pool mode configured explicitly.
- `valkey`: Valkey for shared authentication rate-limit state, with ephemeral storage in local/CI and production profiles.
- `s3`: S3-compatible object storage service, such as MinIO, backed by a persistent named Podman volume in local/CI; production uses its dedicated Quadlet volume.
- `api`: FeathersJS API, dependent on database readiness rather than merely container startup.
- `web`: production frontend image containing static assets.
- `nginx`: local/test reverse proxy, static asset server, API router, and WebSocket endpoint.
- `logs`: Dozzle, connected to the rootless Podman API socket read-only.

Use Compose profiles for local development and CI where their needs differ. Production configuration must not rely on source-code bind mounts or development servers.

### PgBouncer

PgBouncer is a connection pooler, not a replacement for PostgreSQL. The API should use a pooler connection string with session pooling. This preserves compatibility with Knex prepared statements, session variables, advisory locks, and other session-dependent features, at the cost of more active PostgreSQL connections. Configure and monitor explicit application, PgBouncer, and PostgreSQL connection limits so session pooling cannot exhaust the database. PostgreSQL migrations and administrative tasks should use a separate direct administrative connection rather than the application pool.

The pooler must have its own health check and the API must fail clearly when the pooler is unavailable. PostgreSQL remains private to the Compose network; application containers should not need a direct database route.

### PostgreSQL operations

Production PostgreSQL uses a dedicated persistent host volume, separate from S3 and observability storage. Alert at 80% capacity and monitor I/O, connections, checkpoints, and WAL growth. Keep `fsync` and synchronous commit enabled and use PostgreSQL defaults until measured workload data justifies tuning. Initially perform major-version upgrades by creating a new database volume, restoring a tested dump, validating the database, and switching the deployment during a controlled maintenance window. The backup container connects directly to PostgreSQL on the private database network, bypassing PgBouncer, with a dedicated read-only backup role separate from API and migration credentials. Provision that role with explicit grants for application schemas, tables, sequences, and large objects; CI must create it from scratch, run a full dump, restore into a clean database, and verify representative contents. Production releases take a verified backup, run migrations with the direct administrative connection, validate readiness, and only then start or switch to the new API image. Migration failure stops the release for manual restore or a reviewed forward fix; migrations must remain compatible with the currently running API during any transition window.

### S3-compatible object storage

The local Compose and production Quadlet profiles should provide an S3-compatible object storage service using a rootless Podman container and persistent storage. MinIO is the initial candidate because it provides the S3 API needed by the application without requiring a third-party cloud account. Pin a tested MinIO release or image digest and update it deliberately after object-backup and restore testing. The API should use the internal service name and port; the storage console and S3 port should be bound to localhost or a private network unless external access is explicitly required.

The S3 service is intended for:

- application object data such as uploaded documents, images, exports, and other binary files when the product requires them;
- generated application artifacts that are too large or unsuitable for PostgreSQL rows;
- local and CI staging of encrypted `pg_dump`/restic backup archives when testing backup and restore workflows.

It is not intended for users, sessions, activity records, relational business data, PostgreSQL's primary storage, Prometheus metrics, Loki logs, or Grafana's system data. Those belong in PostgreSQL or their dedicated services. In the initial application scaffold, the S3 bucket and object schema should only be added when an upload/export feature actually needs them.

The browser accesses object data through authorized Feathers API operations. The API validates ownership and permissions, then streams objects to or from S3. The S3 API and console are private and are not exposed through public Nginx routes. Presigned URLs can be introduced later if large-file bandwidth makes API-mediated transfers impractical.

The initial API upload limit is 50 MiB per object. Accept only an explicit allowlist of MIME types and extensions, validate detected content type where practical, stream transfers without buffering entire objects in API memory, and reject unknown or oversized objects. v1 includes uploads and exports, with separate S3 buckets for application uploads and generated exports in production. A backup-staging bucket exists only in local/CI profiles; production exports objects directly to the dated NFS staging tree.

In development and CI, the object-storage volume is disposable. In production, it is persistent application infrastructure and must have a volume backup or replication plan. The production S3 service is not a third-party dependency; it is deployed and operated with the rest of this stack. The S3 bucket names, endpoint, region, and path-style setting should be configurable through environment variables so tests can switch between local, CI, and production storage. Use an API-level object export or supported bucket listing/download to create an immutable dated staging tree containing production object bytes, metadata, and checksums, then snapshot that tree with restic. Never copy a live MinIO data directory as if it were a consistent object backup.

Production database backups are stored on an NFS-mounted path accessible from the production host, not in the production S3 bucket. The NFS provider supplies snapshots for logical recovery, but this initial setup does not protect against NFS server, disk, or site loss. Use a dedicated NFS backup export mounted at a fixed path such as `/srv/backups` rather than sharing a general-purpose export. Replication or a second off-site copy is required before claiming host-disaster protection.

Configure the NFS source as a private DNS hostname and export path supplied by deployment configuration, for example `backup-nfs.internal:/exports/app-backups`; do not commit a real hostname or IP address. The systemd NFS mount unit is required before the whole production stack starts, verifies that `/srv/backups` is actually mounted, and fails startup clearly when NFS is unavailable. It must never fall back to an ordinary local directory. The backup container uses a dedicated numeric UID/GID that is authorized by the NFS export, rather than the deployment user's identity.

### Production orchestration

The initial production target is one Linux host using rootless Podman and systemd Quadlet. Run the user-level units under a dedicated deployment user with configured subuid/subgid ranges and systemd lingering enabled so services survive logout and reboot. Quadlet unit files provide service ordering, restart behavior, environment-file integration, and startup after host reboots without requiring a full orchestration platform. External Nginx routes traffic to the API and web loopback upstreams on that host; it does not expose S3 or observability services. Production Quadlet/host services are PostgreSQL, PgBouncer, S3-compatible storage, API, web, backup, Grafana, Prometheus, Loki, and Dozzle, plus host-installed Alloy for journald collection. Loki publishes only `127.0.0.1:3100:3100` for Alloy. PostgreSQL, PgBouncer, S3-compatible storage, and the observability stack are all operated by this deployment.

Production uses separate private networks: `backend` contains API, PgBouncer, PostgreSQL, and Valkey; `object` contains API, S3, and the backup container; and `monitoring` contains API, Prometheus, Grafana, and Loki. The backup container joins only `backend` and `object`. Nginx reaches API and web through host loopback ports, while host Alloy reaches Loki through its loopback port. No private service network is publicly exposed.

The deployment should use immutable image tags, a controlled update procedure, health checks, and a documented rollback to the previous image tag. Move to multiple application hosts or a managed container platform when availability requirements exceed a single-host design.

Initially, CI does not publish images to a registry. The production host builds the API, web, and production service images from a versioned release source using the pinned lockfile and Containerfiles. Use semantic-version tags such as `v1.2.3` plus the exact git SHA, and record both in a versioned GitHub release manifest with the source commit, dependency lockfile checksum, build inputs, and resulting local image digests. The host retains the previous image set for rollback. Revisit a registry when build time, host access, or multi-host deployment makes local production builds impractical.

### Nginx and local TLS

Nginx should be used in integration and end-to-end testing so browser routing, API proxying, WebSocket upgrades, and production-like headers are exercised. The repository owns a test-only Nginx configuration and image; production Nginx configuration and certificates remain external deliverables. Local development can still use direct Vite/Quasar hot reload for speed, but the containerized test profile should run the built web image behind the repository's test Nginx container.

For local HTTPS, use a locally trusted development CA such as `mkcert` and mount the generated certificate and key into the test Nginx container. This keeps the `Secure` refresh cookie behavior identical in local browser E2E tests and production, avoids browser warnings, and keeps certificates out of version control. A simpler self-signed certificate is acceptable for non-browser smoke checks, but it requires explicit trust configuration in browser and test runners. Production certificates are provisioned externally and are never generated or stored by this repository.

### Stack log viewer

Application containers should write structured logs to standard output and standard error. Dozzle is the selected lightweight local/test log viewer and may also run privately in production for operator inspection. In production, bind Dozzle to loopback only and access it through an SSH tunnel, with Dozzle authentication enabled. Expose the user-level Podman API socket to Dozzle as a read-only mount, never expose it through public Nginx routes, and do not mount the host filesystem or a privileged system-wide socket merely to display logs. In production, host-installed Grafana Alloy reads Quadlet service output from journald and forwards it to the self-hosted Loki container; Alloy is the production log shipping path.

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
- Use the default local development ports: Feathers API on `3000`, Vite/Quasar on `5173`, and the test Nginx profile on `8443` for HTTPS and `8080` for HTTP. Keep the same host ports across local, CI, and the test profile to reduce surprise.
- Use the Nginx profile for browser and WebSocket integration testing; use `mkcert` certificates when HTTPS behavior matters.
- Use a non-production database and credentials.
- Keep migrations and seed data repeatable.
- Provide an explicit deterministic local/CI seed command such as `pnpm db:seed`; do not seed automatically on every development startup.

### CI

CI should build the API, web, and Nginx images and run checks against an ephemeral PostgreSQL and PgBouncer stack. At minimum:

- backend unit and service tests;
- frontend unit/component tests;
- linting and type checking;
- database migration tests against PostgreSQL;
- an integration or smoke test through Nginx using the built API and web artifacts;
- a WebSocket upgrade check through Nginx.

The CI build should use the same API and frontend Containerfiles used for deployment, while the test-only Nginx image uses its repository-owned test Containerfile and configuration. This catches missing files, incorrect runtime configuration, and frontend routing issues before release.

### Production
- Use externally managed Nginx, TLS certificates, DNS, and public routing. This deployment operates PostgreSQL, PostgreSQL storage, PgBouncer, S3-compatible storage, Grafana, Prometheus, Loki, and their persistent volumes.
- Create production initial data with a manual, authenticated one-time bootstrap command after migrations. Never auto-create demo users, default passwords, or administrator credentials during API startup.
- Validate the bootstrap workflow before opening the app to real users, and use a single initial admin account created explicitly for the first deployment.
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
- Run one scheduled `pg_dump` backup each day at 02:00 UTC, encrypt and deduplicate it with restic, and store the resulting repository on the production NFS mount. Retain daily PostgreSQL backups for 30 days.
- Run a separate daily S3 object export alongside the database backup at 02:00 UTC. During the coordinated backup window, briefly pause uploads and database writes that create or delete object references, export the current bucket into an immutable dated staging tree with object metadata and checksums, take the PostgreSQL dump and restic snapshot, then resume writes. Store the S3 snapshot in a separate encrypted restic repository on NFS, using the protected operator-managed restic password initially. Retain 30 days of restic snapshots, including prior object states after deletions.
- In local development and CI, point restic and object-storage integration tests at the local `s3` service. Production backup jobs must verify that the NFS mount is present and writable before creating or pruning backups.
- Treat an unavailable NFS mount as a backup failure, alert on it, and do not silently write to a local fallback path that could fill the production host.
- Alert immediately when either backup job fails and alert when no successful coordinated backup exists within 26 hours.
- Document the NFS export, mount point, ownership, permissions, encryption key handling, and the NFS provider's snapshot or replication policy.
- Run the unattended rootless `backup` container with a dedicated numeric UID/GID. Give it private-network access to PostgreSQL for direct `pg_dump` connections, but no application-facing network access. Use a fixed `/srv/backups` mount and store one restic repository password in a protected key file or rootless Podman secret mounted read-only. The single operator owns this password and must keep a separate offline recovery copy; losing it makes the encrypted backup repositories unrecoverable. Test restore access whenever the host or backup configuration changes.
- Add continuous write-ahead-log archiving and point-in-time recovery as a future milestone when a 48-hour best-effort RPO becomes insufficient; it is not available in the initial deployment.
- Restrict who can read or delete backups, and keep backup credentials separate from application credentials.
- Test a full restore monthly. Restore both repositories, verify that database object references resolve, compare object counts and checksums, download representative files, and record the result. A backup is not considered valid until this produces a usable database and object set.
- Document who can start a restore, where the restored database is created, how application access is paused, and how the restored version is verified.

### Migration and rollback policy

- Every schema change is a reviewed, versioned migration committed with the application code.
- Run migrations against a disposable PostgreSQL database in CI before release.
- Prefer expand-and-contract changes: add the new schema first, deploy code that can work with both forms, backfill data, then remove the old schema in a later release.
- Keep production migrations small and transactional where PostgreSQL permits it. Avoid long locks during normal traffic.
- Do not rely on an automatic `down` migration as the primary production rollback mechanism. Rolling application code back while keeping a newer schema is usually safer than reversing a destructive schema change.
- For a failed migration, stop the release, inspect whether the migration committed, restore from the latest verified dump when data was changed incorrectly, and deploy a forward fix when possible.
- Before each release, record the migration version, latest verified backup snapshot, application image version, and the tested recovery procedure.

### Observability policy

- Emit structured JSON logs to standard output with timestamp, level, service, request ID, user ID where appropriate, route, status, duration, and error details. Never log passwords, tokens, or sensitive request bodies.
- Provide separate private health endpoints: `GET /health/live` only confirms that the API process is running, while `GET /health/ready` verifies required dependencies such as PgBouncer are reachable. Deployment and monitoring checks access both endpoints internally; external Nginx does not route them.
- Expose `GET /metrics` in Prometheus text format on the private monitoring network only. Prometheus and the API share an internal Podman network, the API port is not publicly bound, and external Nginx does not route `/metrics`. The endpoint must not contain passwords, tokens, email addresses, user IDs, or other high-cardinality personal data.
- Expose an authenticated `GET /stats` resource for application dashboards. It should return aggregate values such as total users, active users, session counts, activity counts, request/error totals, and time-bucketed trends. Protect it with a dedicated admin/observability permission and apply pagination or bounded time windows where details are requested.
- Keep `/metrics` and `/stats` separate: Prometheus metrics are machine-readable time series for alerting, while `/stats` is an authenticated application API for non-Grafana consumers. Grafana uses only Prometheus data and never connects directly to the application or database.
- Expose bounded business aggregates such as user, session, and activity counts as Prometheus metrics so Grafana can dashboard them through the Prometheus datasource.
- Prometheus scrapes the single `/metrics` endpoint every 15 seconds. Business metrics may use live aggregate queries initially because the expected load is fewer than 50 concurrent users, but queries must use indexed access paths, bounded time windows, database statement timeouts, and a strict query budget. Target p95 business-metric query latency below 250 ms and alert when it exceeds 500 ms; move to cached or summary-table aggregates when the alert persists. If a business query times out, serve operational metrics normally and mark the business metric unavailable with an explicit error/freshness metric rather than failing the whole scrape.
- Track baseline metrics: request count, error count, latency, active connections, pool saturation, migration status, and process health.
- Use stable metric names and low-cardinality labels such as `service`, `route`, `method`, `status_code`, and `environment`. Never label metrics by user, email, session, request ID, or unrestricted URL values.
- Start with Grafana, Prometheus, Loki, and Dozzle as separate rootless services on the same production Linux host. Grafana provides dashboards and alert views, Prometheus stores and evaluates metrics, Loki stores searchable logs, and Dozzle provides private operator inspection. Run Grafana Alloy as a host systemd service that forwards journald logs. Reserve approximately 1 CPU and 1.5-2 GiB RAM for the containerized monitoring stack, with hard per-service CPU and memory limits within that total. Allocate separate persistent volumes of 3 GiB for Prometheus, 6 GiB for Loki, and 1 GiB for Grafana; Dozzle receives no persistent data budget. Alert at 80% usage and enforce retention limits so monitoring cannot consume all application capacity.
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

## Deployment-Specific Configuration

The actual private NFS hostname and export path are supplied outside the repository when production infrastructure is available. They belong in protected deployment configuration, not in an ADR or committed environment file.

Before production, implementation must provide the Quadlet units, NFS mount unit, backup container configuration, Alloy host-service configuration, test Nginx configuration, refresh-session migrations, and the health/metrics access rules described above.
