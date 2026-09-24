# 0062: Private Prometheus `/metrics` endpoint including bounded business aggregates

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (before first production release)
- Source: [Technical architecture › Observability policy](../technical-architecture.md#observability-policy)
- Related: [0024](0024-refresh-session-storage.md), [0027](0027-activity-audit-events.md), [0032](0032-external-nginx-ingress.md), [0035](0035-private-podman-networks.md), [0063](0063-stats-endpoint.md), [0065](0065-alerting.md)

## Context

Prometheus drives alerting and Grafana dashboards. Business aggregates such as users, sessions, and activity should be on those dashboards without Grafana touching the database.

## Decision

- Expose `GET /metrics` in Prometheus text format on the private monitoring network only. External Nginx doesn't route it, and the API port isn't publicly bound.
- The endpoint never contains passwords, tokens, email addresses, user IDs, or other high-cardinality personal data.
- Expose bounded business aggregates (user, session, activity counts) as Prometheus metrics.
- Prometheus scrapes this single endpoint every **15 seconds**.
- Business metrics may use live aggregate queries initially (fewer than 50 concurrent users expected), but only with indexed access paths, bounded time windows, statement timeouts, and a strict query budget.
- Target p95 business-metric query latency **below 250 ms**, alert **above 500 ms**. Move to cached or summary-table aggregates if the alert persists.
- If a business query times out, serve operational metrics normally and mark that business metric unavailable with an explicit error/freshness metric.
- Baseline metrics: request count, error count, latency, active connections, pool saturation, migration status, process health.
- Stable metric names and low-cardinality labels (`service`, `route`, `method`, `status_code`, `environment`). Never label by user, email, session, request ID, or unrestricted URL values.

## Consequences

- One scrape target covers operational and business metrics.
- Database load from scraping must be watched.

## ToDos

- ToDo: [Contradiction] "Private monitoring network only" isn't achievable while `/metrics` shares the API listener that also sits on `backend` and `object` and is published on `127.0.0.1:3000` for public Nginx (ADR 0032, 0035).
- ToDo: [Clarify] Running aggregate queries on every 15-second scrape (about 5,760 times a day) is wasteful for values like active users per day. Consider computing business metrics on a slower schedule and caching them, independent of scrapes.
- ToDo: [Missing] Fixed windows for business metrics (for example 1 d / 7 d / 30 d). Prometheus has no "selected period" like `/stats`.
- ToDo: [Missing] What the "strict query budget" actually is (maximum queries per scrape, total time).
- ToDo: [Clarify] Business-metric queries use the API's session-pooled connections and compete with user requests (ADR 0014).
- ToDo: [Clarify] Definitions of "migration status" and "active connections" (HTTP, WebSocket, or database?).
- ToDo: [Clarify] The `route` label must be the route template or Feathers service path, never a raw path containing IDs.
- ToDo: [Contradiction] "Scrapes the single `/metrics` endpoint", while required alerts need PostgreSQL, PgBouncer, host, and backup metrics from other sources (ADR 0035, 0065).
- ToDo: [Clarify] Share metric definitions with `/stats` so the numbers don't diverge (ADR 0063).
