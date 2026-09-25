# 0002: Service inventory and network segmentation

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0035, 0037
- Related: [0001](0001-one-stack-every-environment.md), [0004](0004-pgbouncer-pools.md), [0008](0008-authentication-saml2-ldap.md), [0015](0015-testing-vitest-playwright.md), [0017](0017-nfs-backup-storage.md), [0020](0020-object-storage-uploads.md), [0022](0022-observability-and-alerting.md), [0023](0023-secrets-management.md), [0024](0024-background-jobs-bullmq.md)

## Context

The stack needs a fixed service list and a network layout where no component can reach a peer it has no business reaching. The previous network plan put the API and PostgreSQL on one network while also claiming the API had no direct database route, and put the backup container on the same network as the API while claiming it had no application access. Both claims were false as drawn.

## Decision

### Services

| Service | Role | Production counterpart |
| --- | --- | --- |
| `nginx` | Reverse proxy, TLS termination, serves the built frontend bundle | same |
| `web` | Vite dev server, `dev` profile only. In CI and production the built bundle is part of the `nginx` image | — |
| `api` | FeathersJS application | same |
| `worker` | BullMQ worker; same image as `api`, different command ([0024](0024-background-jobs-bullmq.md)) | same |
| `pgbouncer` | Connection pooler | same |
| `postgres` | PostgreSQL 18 | same |
| `valkey` | Rate-limit state and job queues, persisted to disk | same |
| `s3` | Garage, S3-compatible object storage | same |
| `openbao` | Secret store ([0023](0023-secrets-management.md)) | same |
| `*-agent` | One OpenBao Agent per service that reads secrets | same |
| `idp` | Keycloak, SAML2 identity provider | university IdP (external) |
| `ldap` | OpenLDAP, seeded test directory | university directory (external) |
| `mail` | Mailpit, SMTP capture | university SMTP relay (external) |
| `certs` | One-shot job creating the local CA and certificates | ACME client (see [0016](0016-nginx-and-tls-everywhere.md)) |
| `dozzle` | Dozzle, a live browser view of container output; local only, a developer convenience | — |
| `prometheus` | Metrics store | same |
| `loki` | Log store | same |
| `alloy` | Grafana Alloy, log shipper; replaced Promtail, end of life since 2026-03 ([0021](0021-structured-logging.md)) | same |
| `grafana` | Dashboards and alerting | same |
| `postgres-exporter` | PostgreSQL metrics | same |
| `pgbouncer-exporter` | PgBouncer pool metrics | same |
| `valkey-exporter` | Valkey memory and queue metrics | same |
| `node-exporter` | Host CPU, memory and volume metrics | same |
| `blackbox` | blackbox_exporter, the uptime check of the public endpoint | must run on another machine ([0022](0022-observability-and-alerting.md)) |
| `backup` | Scheduled `pg_dump` + restic service | same |
| `migrate` | One-shot Knex migration job | same |
| `test` | One-shot Vitest run for unit and integration tests, built from the `api` build stage; `test` profile only ([0015](0015-testing-vitest-playwright.md)) | — |
| `e2e` | One-shot Playwright run; `test` profile only ([0015](0015-testing-vitest-playwright.md)) | — |

### Networks

| Network | Members | Purpose |
| --- | --- | --- |
| `edge` | `nginx`, `api`, `web` (dev), `blackbox`, `e2e` (test) | Public request path; Nginx is also `app.localhost` here locally, so clients inside the stack reach the public origin |
| `idp-edge` | `nginx`, `idp`, `e2e` (test) | Browser access to the local IdP; local and CI only |
| `dozzle-edge` | `nginx`, `dozzle` | Browser access to Dozzle; local only |
| `grafana-edge` | `nginx`, `grafana` | Browser access to Grafana ([0022](0022-observability-and-alerting.md)) |
| `mail-edge` | `nginx`, `mail` | Browser access to Mailpit's inbox; local only |
| `app-data` | `api`, `worker`, `pgbouncer`, `valkey`, `valkey-exporter`, `test` (test) | Application data access |
| `db` | `pgbouncer`, `postgres`, `backup`, `migrate`, `postgres-exporter`, `pgbouncer-exporter` | Direct database access |
| `identity` | `api`, `idp`, `ldap`, `test` (test) | Authentication and directory lookup |
| `object` | `api`, `worker`, `s3`, `backup` | Object storage |
| `secrets` | `openbao`, every `*-agent`, `backup` | Secret delivery; `backup` for OpenBao snapshots |
| `observability` | `api`, `worker`, `prometheus`, `loki`, `alloy`, `grafana`, all exporters, `mail`, `blackbox` | Metrics, logs, alert delivery |

Consequences of this layout, all intentional:

- The `api` and `worker` are on `app-data` but not on `db`, so they physically cannot bypass PgBouncer.
- The `backup` service is on `db`, `object` and `secrets` only. It has no route to the API, the worker or Valkey. It reaches its NFS target through a host mount, not a network ([0017](0017-nfs-backup-storage.md)), and reads Valkey's snapshot file from a read-only volume mount.
- `postgres` is reachable only from `db`.
- `s3` is reachable only by the API, the worker and the backup service, never by Nginx, so object bytes can only leave through an authorized API call ([0020](0020-object-storage-uploads.md)).
- `ldap` is reachable by the API because administrators and operators look users up in the directory ([0008](0008-authentication-saml2-ldap.md)). It is not reachable by Nginx: the browser only needs the IdP, which is why `idp-edge` is a separate network.
- `dozzle` is reachable only by Nginx, under its own host name ([0016](0016-nginx-and-tls-everywhere.md)). It reads container output through the rootless Podman API socket, bind-mounted from the host, which gives it control over the developer's containers; it runs with actions and shell disabled and filtered to this project, and exists only under the `local` profile. It is not part of log collection or alerting ([0022](0022-observability-and-alerting.md)).
- `openbao` is reachable only by agents and the backup service. Application containers never talk to it; they read files the agent wrote.
- The `api` and `worker` join `observability` for scraping and, for the worker, for SMTP. This is wider than a dedicated scrape network and is accepted as the cost of a flat single-host model.
- The API's metrics and health listener is a separate port reachable only on `observability` ([0022](0022-observability-and-alerting.md)).
- `grafana` and, locally, `mail` are reachable by Nginx under their own host names, each on a network of its own like `dozzle` ([0016](0016-nginx-and-tls-everywhere.md)). Prometheus, Loki and the exporters have no browser route; people use Grafana.
- `node-exporter` shares the host's process namespace and reads the host's root read-only, and `alloy` reads the host's journal read-only: host metrics and third-party container output ([0021](0021-structured-logging.md)) have no other source.
- The test runners sit where the code they test sits. `test` is on `app-data` and `identity`, like the API, so integration tests reach PostgreSQL through PgBouncer and cannot bypass it, and reach the test directory as the API's directory lookup does; the migration into `test_template` is done by the `migrate` job. `e2e` is on `edge` and `idp-edge`, like a browser, and reaches nothing else. Neither exists in production.

Only `nginx` publishes ports to the host. Every other service is reachable only on its private networks.

## Consequences

- Nine networks, each removing a specific reachability the previous plan claimed but did not enforce.
- The `api` joins five networks and remains the hub, which is inherent to a single-application stack.
- One-shot and scheduled jobs (`migrate`, `certs`, `backup`) need explicit network membership, which the generated Quadlet units inherit from `compose.yaml`.
