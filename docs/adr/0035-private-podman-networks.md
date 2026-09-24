# 0035: Segment production containers into `backend`, `object`, and `monitoring` networks

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › Production orchestration](../technical-architecture.md#production-orchestration)
- Related: [0014](0014-pgbouncer-session-pooling.md), [0015](0015-database-roles-and-connection-paths.md), [0049](0049-coordinated-object-backup.md), [0051](0051-backup-container-isolation.md), [0064](0064-observability-stack.md), [0065](0065-alerting.md)

## Context

Services on one host should reach only the peers they need, and no private service network should be publicly exposed.

## Decision

- `backend`: API, PgBouncer, PostgreSQL, Valkey.
- `object`: API, S3, backup container.
- `monitoring`: API, Prometheus, Grafana, Loki.
- The backup container joins only `backend` and `object`.
- Nginx reaches API and web through host loopback ports. Host Alloy reaches Loki through its loopback port.
- No private service network is publicly exposed.

## Consequences

- Observability and object storage are isolated from the database network.
- The API joins every network and is the hub between them.

## ToDos

- ToDo: [Contradiction] `backend` puts the API and PostgreSQL on the same network, so the API has a direct database route, although ADR 0014 says application containers shouldn't need one. A separate database network (PgBouncer, PostgreSQL, backup, migration job) would match that intent.
- ToDo: [Contradiction] The backup container joins `backend`, which gives it network access to the API and Valkey, despite "no application-facing network access" (ADR 0051). At the same time, the backup write pause (ADR 0049) requires the backup to signal the API, and no path for that is defined.
- ToDo: [Contradiction] Prometheus is only on `monitoring`, but required alerts cover PgBouncer pool exhaustion, PostgreSQL storage and connections, and backup failures (ADR 0065). Prometheus can't reach PgBouncer, PostgreSQL, Valkey, S3, or the backup job. Exporters (PostgreSQL, PgBouncer, node, MinIO metrics) and their network placement are missing.
- ToDo: [Clarify] The API joins `monitoring` alongside Loki and Grafana although it only needs to be scraped. Check against least privilege.
- ToDo: [Missing] Networks for one-shot jobs: migrations, bootstrap, maintenance, restore.
- ToDo: [Missing] Outbound internet access for the API (email delivery, ADR 0026). Decide which networks are `internal` (no egress).
- ToDo: [Clarify] Confirm that the web container and Dozzle join no private network.
- ToDo: [Clarify] Local/CI Compose uses a single network, so the production segmentation is never exercised before production (ADR 0037).
