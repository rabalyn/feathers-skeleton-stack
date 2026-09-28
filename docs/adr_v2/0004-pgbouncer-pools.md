# 0004: PgBouncer in transaction mode for all pooled access; direct connections only for migrations and backup

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADR 0014
- Related: [0002](0002-service-inventory-and-networks.md), [0003](0003-postgresql-and-knex.md), [0015](0015-testing-vitest-playwright.md), [0016](0016-nginx-and-tls-everywhere.md), [0024](0024-background-jobs-bullmq.md)

## Context

Connection exhaustion must never be a failure mode, including when a test suite runs heavily parallel on a 48-core machine. Forty-eight Vitest workers each holding a Knex pool of ten is 480 client connections against a PostgreSQL default `max_connections` of 100.

Session pooling does not solve this: it binds one server connection to each client connection for that client's entire lifetime. Transaction pooling does, because a server connection is assigned only for the duration of a transaction.

A common objection to transaction pooling is that it breaks transactions. It does not. `BEGIN … COMMIT/ROLLBACK` is exactly PgBouncer's unit of assignment in transaction mode, so `knex.transaction()` works normally, including rollback of a failed chain of service calls and nested transactions via savepoints.

## Decision

All pooled access — API, worker, integration tests — goes through PgBouncer in **`transaction`** mode. `migrate` and `backup` connect directly to PostgreSQL, bypassing PgBouncer.

There is no session-mode pool. The background jobs in scope are batched deletes and queue consumers whose state lives in Valkey ([0024](0024-background-jobs-bullmq.md)); none needs session state. A job that later genuinely needs it (session advisory locks, `LISTEN`/`NOTIFY`, cursors spanning transactions) adds a session pool at that point.

### Sizing

| Setting | Value | Why |
| --- | --- | --- |
| `pool_mode` | `transaction` | See above |
| `default_pool_size` | 25 | Server connections per database/user pair for the application |
| `max_client_conn` | 1000 | Client connections are cheap; server connections are what is limited |
| `max_user_connections` for the test user | 60 | Global cap on server connections across all per-worker test databases ([0015](0015-testing-vitest-playwright.md)) |
| PostgreSQL `max_connections` | 100 | Leaves room for direct connections and exporters |

Databases are routed with a wildcard `*` entry, so per-worker test databases need no PgBouncer configuration change.

PgBouncer keeps one pool per database/user pair. With one database per test worker, workers do not share server connections; the overall ceiling is `max_user_connections`, and a worker that hits it waits instead of failing. The application in production uses one database and therefore one shared pool of 25.

### Rules imposed by transaction mode

- Use `knex.transaction()` freely. Fully supported.
- Use `SET LOCAL` inside a transaction, never session-level `SET`.
- Use `pg_advisory_xact_lock` / `pg_try_advisory_xact_lock`, never session-scoped `pg_advisory_lock`.
- No `LISTEN`/`NOTIFY`, no temp tables outliving a transaction, no server-side named prepared statements. Knex with `node-postgres` does not create named prepared statements by default.

Authentication is `scram-sha-256`.

### TLS on both hops

Both database hops use TLS with full verification, so query data and results — personal data — never cross a container network in plaintext:

- clients (API, worker, tests) → PgBouncer: PgBouncer requires TLS from clients; clients verify its certificate and host name against the CA root,
- PgBouncer → PostgreSQL, and `migrate` / `backup` → PostgreSQL: PostgreSQL accepts only `hostssl` connections; its clients verify with `verify-full`.

Locally and in CI the certificates come from the `certs` job's local CA ([0016](0016-nginx-and-tls-everywhere.md)). The CPU cost of TLS is paid per connection, which pooling amortises.

PgBouncer is stopped with **SIGINT**, its safe shutdown: transactions in progress finish, then it exits. Its SIGTERM (since 1.23) waits for every client to disconnect, which ran into Podman's 10-second SIGKILL whenever a client outlived the stop.

## Consequences

- A parallel test run of any width is bounded by `max_user_connections` rather than by PostgreSQL's `max_connections`.
- Application code carries a small set of rules that are easy to violate accidentally; an ESLint rule over `apps/api` refuses session-level `SET` and session advisory locks (`pg_advisory_lock`, `pg_try_advisory_lock` and their unlocks) in SQL strings. `migrate`, which connects directly, disables it for its one `SET lock_timeout`. `LISTEN`/`NOTIFY` and temp tables are not linted; they have no use here yet.
- Pool saturation is visible through `pgbouncer-exporter` and the API's own pool metrics ([0022](0022-observability-and-alerting.md)).
