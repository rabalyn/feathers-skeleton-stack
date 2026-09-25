# 0022: Prometheus, Loki and Grafana, with email alerting and an external uptime check

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0062, 0063, 0064, 0065, 0066
- Related: [0002](0002-service-inventory-and-networks.md), [0004](0004-pgbouncer-pools.md), [0006](0006-feathersjs-typescript-api.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0017](0017-nfs-backup-storage.md), [0021](0021-structured-logging.md), [0023](0023-secrets-management.md)

## Context

The deployment needs metrics, searchable logs, dashboards, and an alert that actually reaches a person. The previous design defined alerts on PgBouncer pools, PostgreSQL storage and backup jobs that Prometheus had no network path to scrape and no exporter to scrape from — alerts that could never fire. Every alert defined here has a corresponding source in the service inventory.

## Decision

### Stack

| Service | Role |
| --- | --- |
| `prometheus` | Scrapes and stores metrics, 14-day retention |
| `loki` | Stores logs from Promtail, 14-day retention enforced by the compactor |
| `grafana` | Dashboards, alert rules, and alert delivery |
| `promtail` | Ships log files to Loki ([0021](0021-structured-logging.md)) |
| `postgres-exporter` | PostgreSQL metrics |
| `pgbouncer-exporter` | PgBouncer pool metrics |
| `valkey-exporter` | Valkey memory, keys and queue metrics |
| `node-exporter` | Host CPU, memory and volume usage |
| `uptime` | Uptime Kuma, checking the public endpoint from outside |
| `mail` | Mailpit locally and in CI; university SMTP relay in production |

All run as containers in every environment ([0001](0001-one-stack-every-environment.md)).

The local stack additionally runs Dozzle ([0002](0002-service-inventory-and-networks.md)), a live view of container output for developers. It is not part of this stack: it reads stdout through the Podman API rather than the log files, keeps nothing, feeds no dashboard or alert, and has no production counterpart. Nothing here may depend on it.

### Internal and public endpoints

- The API and the worker expose `GET /metrics` in Prometheus format, and the API exposes health and readiness endpoints, on an **internal port** reachable only on the `observability` network. Nginx never routes them, and they sit outside the Feathers authentication pipeline. Container health checks call them from inside the container.
- **Every observability hop uses TLS**, verified against the CA root like the data hops ([0004](0004-pgbouncer-pools.md), [0016](0016-nginx-and-tls-everywhere.md)): scrapes of the internal ports and every exporter, the log push to Loki, Grafana's queries to Prometheus and Loki, mail to Mailpit, and Nginx to Grafana and Mailpit. Each listener has a certificate for its own service name; the API's and the worker's also name `localhost`, for the container healthcheck. Locally the `certs` job issues them; production's source is the private CA still open in [0016](0016-nginx-and-tls-everywhere.md).
- The only public liveness signal is `GET /api/ping` through Nginx. It returns a constant and says nothing about internal state; it exists for the uptime check.
- Observability for people is Grafana: dashboards and alerts, not raw endpoints.

### Metrics

Baseline series from the API: request count, error count, request duration histogram, active WebSocket connections, **Knex pool usage** (in use, idle, waiting). From the worker: job outcomes and durations per queue.

- In Prometheus terms: `http_requests_total{route,method,status_code}` (errors are its 5xx), `http_request_duration_seconds{route,method}`, `websocket_connections`, `knex_pool_connections{state}`; `bullmq_jobs_total{queue,outcome}` (`completed`, `retried`, `failed`), `bullmq_job_duration_seconds{queue}` and `bullmq_queue_jobs{queue,state}`; plus Node's process metrics. HTTP requests and WebSocket calls are counted alike, the `method` telling them apart as in the request log ([0021](0021-structured-logging.md)). Every series carries `service`. PgBouncer's own view of pool saturation comes from `pgbouncer-exporter`, so pool pressure is visible from both sides of the pooler.

Labels are low-cardinality — `service`, `route` (as route template, never a path containing an id), `method`, `status_code`, `queue`, `environment`. Never labelled by user, session or request id.

Prometheus scrapes every target every 15 seconds.

### Alerting is Grafana's, and it delivers email

Grafana's unified alerting evaluates rules against **both** Prometheus and Loki and delivers notifications itself. This replaces the usual Loki-ruler-plus-Alertmanager pair with one component, which is the right trade for a deployment with one operator.

The recipient address is deployment configuration and may be a distribution list. SMTP credentials come from OpenBao ([0023](0023-secrets-management.md)).

Rules, contact points and dashboards are **provisioned as code** from files in the repository. Nothing important is created by clicking in the UI, because that is state nobody backs up. For the same reason alerting is not part of the application's runtime settings.

### Alert set

| Alert | Source | Condition |
| --- | --- | --- |
| Application errors in logs | Loki | Rate of `level=error` lines over 5 minutes exceeds threshold |
| Authentication anomaly | Loki | Sustained rate-limit rejections or repeated failed break-glass logins |
| Backup failure | Loki | An error line from the backup service, or no success line within 26 hours ([0017](0017-nfs-backup-storage.md)) |
| API down | Prometheus | Scrape target unreachable |
| API error rate | Prometheus | Sustained 5xx ratio above threshold |
| API latency | Prometheus | p95 request duration above threshold |
| Database storage | `postgres-exporter` | Volume above 80% |
| Database connections | `postgres-exporter`, `pgbouncer-exporter` | Server connections approaching `max_connections`, or clients waiting in PgBouncer |
| Volume capacity | `node-exporter` | Any data, log or backup volume above 80% |

Valkey memory is shown on a dashboard without an alert. The job volume in scope is small; the dashboard shows whether the host needs more memory ([0010](0010-sessions-postgres-ratelimits-valkey.md)).

The backup alert's 26-hour window assumes the default daily schedule. The backup schedule is a runtime setting while alert rules are code, so changing the schedule means changing this rule too.

### Uptime check

Uptime Kuma checks `GET /api/ping` over the public host name and the TLS certificate's expiry, and notifies by email. **It is in the stack for now so the check exists from the start, but it must move to a different machine for production**: running on the monitored host, it goes silent exactly when the host fails, which is the one failure it exists to report.

### Mail in every environment

Locally and in CI the `mail` container (Mailpit) captures alert email, so the delivery path — rule fires, notification renders, SMTP send succeeds — is testable without sending real mail. An alert that has never been seen to arrive is not an alert.

### Retention and budget

Observability data is retained **14 days**, matching the log retention in [0013](0013-gdpr-export-and-retention.md). Prometheus, Loki and Grafana each get a bounded persistent volume with hard CPU and memory limits, so monitoring cannot starve the application on a shared host.

Distributed tracing is deferred. Request correlation uses `request_id` ([0021](0021-structured-logging.md)); its format should be compatible with W3C `traceparent` so adopting tracing later does not break correlation.

## Consequences

- Every alert listed has a scrape target or log stream behind it, so the alert set is deliverable rather than aspirational.
- About ten observability containers run in every environment, including on developer machines.
- Until Uptime Kuma runs elsewhere, a host outage silences all monitoring.

## Open questions

- Concrete thresholds for error rate, latency and authentication anomalies. These start as guesses and are tuned after observing normal behaviour.
