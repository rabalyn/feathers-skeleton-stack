# 0014: Put PgBouncer in session pooling mode between the API and PostgreSQL

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend, PgBouncer, Runtime Topology](../technical-architecture.md#pgbouncer)
- Related: [0012](0012-knex-adapter-and-migrations.md), [0015](0015-database-roles-and-connection-paths.md), [0035](0035-private-podman-networks.md), [0060](0060-health-endpoints.md)

## Context

The API needs pooled PostgreSQL connections with explicit limits. Transaction pooling breaks session-dependent features, while direct connections give no central cap.

## Decision

Run PgBouncer in front of PostgreSQL in local, CI, and production environments. The API connects only to PgBouncer, using session pooling, which keeps prepared statements, session variables, advisory locks, and other session features working at the cost of more active PostgreSQL connections. Configure and monitor explicit application, PgBouncer, and PostgreSQL connection limits. PgBouncer has its own health check, and the API fails clearly when it is unavailable. PostgreSQL stays private to the container network. Migrations and administrative tasks use a separate direct connection (ADR 0015).

## Consequences

- One more service to deploy, configure, secure, and monitor.
- Session features stay available to application code.
- Connection limits must be sized across three layers.

## ToDos

- ToDo: [Contradiction] Session pooling binds one server connection to each client connection for its lifetime. Knex keeps a long-lived pool, so for a single API process PgBouncer adds almost no pooling benefit while adding a component. State the concrete benefit (hard connection cap, smoother API restarts, several clients such as maintenance jobs) or reconsider (direct connection, or transaction pooling with PgBouncer's protocol-level prepared-statement support).
- ToDo: [Verify] The prepared-statement rationale (see ADR 0012).
- ToDo: [Missing] No numbers are given: Knex pool min/max, PgBouncer `default_pool_size` / `max_client_conn`, PostgreSQL `max_connections`. Also count connections used by metrics queries, the maintenance job, bootstrap, and backup.
- ToDo: [Contradiction] "PostgreSQL remains private… application containers should not need a direct database route". But the production `backend` network places the API and PostgreSQL on the same network (ADR 0035), and a locally run API or migration needs a host-published database port (ADR 0053).
- ToDo: [Clarify] PgBouncer authentication: `auth_type` (for example `scram-sha-256`), `auth_query` or a static `userlist.txt`, and how that file is delivered as a secret (ADR 0067).
- ToDo: [Verify] Image source. There is no official upstream PgBouncer container image, and Bitnami moved most versioned images to a legacy repository in 2025. Choose a maintained image or build one; no PgBouncer Containerfile appears in the repository layout (ADR 0018).
- ToDo: [Clarify] What "fail clearly" means: readiness reports not-ready, the process exits, or startup retries with backoff.
- ToDo: [Missing] Monitoring pool saturation needs a PgBouncer exporter that Prometheus can reach. None is in the service inventory or network plan (ADR 0035, 0065).
