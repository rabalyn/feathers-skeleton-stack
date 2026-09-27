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
| `loki` | Stores logs from Alloy, 14-day retention enforced by the compactor |
| `grafana` | Dashboards, alert rules, and alert delivery |
| `alloy` | Grafana Alloy: ships log files and container output to Loki ([0021](0021-structured-logging.md)); replaced Promtail, end of life since 2026-03 |
| `postgres-exporter` | PostgreSQL metrics |
| `pgbouncer-exporter` | PgBouncer pool metrics |
| `valkey-exporter` | Valkey memory, keys and queue metrics |
| `node-exporter` | Host CPU, memory and volume usage |
| `blackbox` | blackbox_exporter, probing the public endpoint for the uptime check |
| `mail` | Mailpit locally and in CI; university SMTP relay in production |

All run as containers in every environment ([0001](0001-one-stack-every-environment.md)).

The local stack additionally runs Dozzle ([0002](0002-service-inventory-and-networks.md)), a live view of container output for developers. It is not part of this stack: it reads stdout through the Podman API rather than the log files, keeps nothing, feeds no dashboard or alert, and has no production counterpart. Nothing here may depend on it.

### Internal and public endpoints

- The API and the worker expose `GET /metrics` in Prometheus format, and the API exposes health and readiness endpoints, on an **internal port** reachable only on the `observability` network. Nginx never routes them, and they sit outside the Feathers authentication pipeline. Container health checks call them from inside the container.
- **Readiness** (`GET /health/ready`) checks what the API needs to serve its requests: PostgreSQL through PgBouncer (`select 1`), Valkey (`PING`) and the object store (`HeadBucket` on the uploads bucket, [0020](0020-object-storage-uploads.md)), each bounded to 1 second. It answers 200, or 503 while any is down, with each check's state (`{"status":"down","checks":{"postgres":"ok","valkey":"down","s3":"ok"}}`). The IdP and LDAP are deliberately left out: a university outage must not mark the API unready while existing sessions keep working. The worker has liveness only.
- The container healthcheck stays on **liveness**, so a database or Valkey outage never makes Podman restart the API. Readiness reaches Prometheus as `dependency_up{dependency}`, the same checks run at scrape time, and alerts from there.
- **Every observability hop uses TLS**, verified against the CA root like the data hops ([0004](0004-pgbouncer-pools.md), [0016](0016-nginx-and-tls-everywhere.md)): scrapes of the internal ports, every exporter and Garage's metrics ([0020](0020-object-storage-uploads.md)), the log push to Loki, Grafana's queries to Prometheus and Loki, mail to Mailpit, and Nginx to Grafana and Mailpit. Each listener has a certificate for its own service name; the API's and the worker's also name `localhost`, for the container healthcheck. Locally the `certs` job issues them; production's source is the private CA still open in [0016](0016-nginx-and-tls-everywhere.md).
- The only public liveness signal is `GET /api/ping` through Nginx. It returns a constant and says nothing about internal state; it exists for the uptime check.
- Observability for people is Grafana: dashboards and alerts, not raw endpoints. Nginx serves it under its own host name (`grafana.localhost` locally), and people log in with Grafana's own admin account, whose password comes from OpenBao ([0023](0023-secrets-management.md)). Locally Nginx also serves Mailpit's inbox (`mail.localhost`), where alert mail lands ([0016](0016-nginx-and-tls-everywhere.md)).

### Metrics

Baseline series from the API: request count, error count, request duration histogram, active WebSocket connections, **Knex pool usage** (in use, idle, waiting). From the worker: job outcomes and durations per queue.

- In Prometheus terms: `http_requests_total{route,method,status_code}` (errors are its 5xx), `http_request_duration_seconds{route,method}`, `websocket_connections`, `knex_pool_connections{state}`, `dependency_up{dependency}` (readiness, above); `bullmq_jobs_total{queue,outcome}` (`completed`, `retried`, `failed`), `bullmq_job_duration_seconds{queue}` and `bullmq_queue_jobs{queue,state}`; plus Node's process metrics. HTTP requests and WebSocket calls are counted alike, the `method` telling them apart as in the request log ([0021](0021-structured-logging.md)). Every series carries `service`. PgBouncer's own view of pool saturation comes from `pgbouncer-exporter`, so pool pressure is visible from both sides of the pooler.

Labels are low-cardinality — `service`, `route` (as route template, never a path containing an id), `method`, `status_code`, `queue`, `environment`. Never labelled by user, session or request id.

Prometheus scrapes every target every 15 seconds.

### Alerting is Grafana's, and it delivers email

Grafana's unified alerting evaluates rules against **both** Prometheus and Loki and delivers notifications itself. This replaces the usual Loki-ruler-plus-Alertmanager pair with one component, which is the right trade for a deployment with one operator.

The recipient address is deployment configuration and may be a distribution list. Grafana sends through the same SMTP server, port and TLS rule as the application's mail, from the same deployment configuration ([0027](0027-email-templates-and-sending.md)); it reads them from its environment rather than from the application, so alert mail works when the application does not. There is no SMTP login: the university relay accepts mail from the stack's hosts by their DNS names, without authentication.

Rules, contact points and dashboards are **provisioned as code** from files in the repository. Nothing important is created by clicking in the UI, because that is state nobody backs up. For the same reason alerting is not part of the application's runtime settings.

### Alert set

| Alert | Source | Condition |
| --- | --- | --- |
| Application errors in logs | Loki | Rate of `level=error` lines over 5 minutes exceeds threshold |
| Authentication anomaly | Loki | Sustained rate-limit rejections or repeated failed break-glass logins |
| Break-glass login | Loki | Any successful login with the break-glass account ([0008](0008-authentication-saml2-ldap.md)) |
| Backup failure | Loki | An error line from the backup service, or no success line within 26 hours ([0017](0017-nfs-backup-storage.md)) |
| API down | Prometheus | Scrape target unreachable |
| API not ready | Prometheus | A dependency of readiness down |
| API error rate | Prometheus | Sustained 5xx ratio above threshold |
| API latency | Prometheus | p95 request duration above threshold |
| Database storage | `postgres-exporter` | Volume above 80% |
| Database connections | `postgres-exporter`, `pgbouncer-exporter` | Server connections approaching `max_connections`, or clients waiting in PgBouncer |
| Volume capacity | `node-exporter` | Any data, log or backup volume above 80% |

As built (`containers/grafana/provisioning/alerting/rules.yaml`), with first-guess thresholds: more than 5 error lines in 5 minutes; more than 20 rate-limit rejections in 10 minutes, or more than 3 refused break-glass logins in 10 minutes (a rule of its own); any successful break-glass login; 5xx above 5% or p95 above 1 s for 10 minutes; a readiness dependency down for 2 minutes; server connections above 80% of `max_connections` for 5 minutes, or any client waiting in PgBouncer for 2 minutes; any filesystem above 80% for 10 minutes. "API down" covers every scrape target, not only the API. "Database storage" is the volume rule: the database's volume lives on a host filesystem node-exporter reports. The backup alert is two rules: any `error` or `fatal` line of the backup service within the last hour, and no `backup completed` line within 26 hours, which also fires when there has never been one, a fresh deployment or a developer machine off at 03:00 included ([0017](0017-nfs-backup-storage.md)). The uptime check adds two rules: the public endpoint failing for 2 minutes, and its certificate expiring within 14 days.

A lost Valkey connection is logged at `warn`, not `error`, by the worker as by the API: the client reconnects, and an outage that lasts is caught by "API not ready" (`dependency_up{dependency="valkey"}`). At `error`, every Valkey restart, including each `scripts/stack.sh up` that recreates it, fired "Application errors in logs" and mailed the operators.

Valkey memory is shown on a dashboard without an alert. The job volume in scope is small; the dashboard shows whether the host needs more memory ([0010](0010-sessions-postgres-ratelimits-valkey.md)).

The backup alert's 26-hour window assumes the default daily schedule. The backup schedule is a runtime setting while alert rules are code, so changing the schedule means changing this rule too.

### Uptime check

`blackbox_exporter` fetches `GET /api/ping` over the public host name, expects its constant body over a certificate the CA root verifies, and reports the certificate's expiry; Prometheus scrapes it and Grafana alerts by email like every other rule. The probed URLs are deployment configuration (`containers/prometheus/targets/uptime.yml`). Uptime Kuma was the original choice, but its checks live in its own database and cannot be provisioned from files, against the rule above. **It is in the stack for now so the check exists from the start, but it must move to a different machine for production**: running on the monitored host, it goes silent exactly when the host fails, which is the one failure it exists to report. On that machine it needs a Prometheus of its own, or it must be scraped from there.

### Mail in every environment

Locally and in CI the `mail` container (Mailpit) captures alert email, so the delivery path — rule fires, notification renders, SMTP send succeeds — is testable without sending real mail. An alert that has never been seen to arrive is not an alert. `scripts/stack.sh alerts`, part of the CI gate, proves it end to end: it makes the worker log errors, and waits for Grafana's mail about them — through Alloy, Loki, the rule, and SMTP — to arrive in Mailpit. It then logs in and out once with the local break-glass account through Nginx and waits for the "Break-glass login" mail, the one rule that exists to catch a single event. The API's integration tests pin the log messages both break-glass rules match ([0008](0008-authentication-saml2-ldap.md)), since a reworded message would silently disable its alert.

Alertmanager mails an alert group once when it starts firing, then stays quiet while it keeps firing and for `repeat_interval` (4 hours) after, unless it has mailed the resolution in between; its notification log survives restarts in Grafana's volume. A check that fires a rule again inside that window gets no mail although delivery works, so each of the two checks first waits for a clean slate: no instance of its rule firing, and either the last episode's `[RESOLVED]` mail in Mailpit or the rule `Normal` for longer than `group_interval` (5 minutes), by when Grafana has sent it. Only then does it fire the rule, and it accepts only a `[FIRING]` mail created after that. Accepting a mail from shortly before the check, or grouping the check's errors apart by a label of their own, were rejected: the first no longer proves that this run's errors produced a mail, the second puts test machinery into production rules. The cost is time: a check run within about 15 minutes of an earlier firing of the same rule, such as `alerts` twice in a row, waits until then (the check gives up after 20 minutes per rule); a cold CI run does not wait.

### Retention and budget

Observability data is retained **14 days**, matching the log retention in [0013](0013-gdpr-export-and-retention.md). Prometheus, Loki and Grafana each get a bounded persistent volume with hard CPU and memory limits, so monitoring cannot starve the application on a shared host: one CPU each, 1 GB for Prometheus and Loki, 512 MB for Grafana, to be revisited with the production host.

Dashboards are provisioned from `containers/grafana/dashboards/`; the first, "Application overview", covers the public endpoint, the API, jobs, the data tier, the host and the application's error lines.

Distributed tracing is deferred. Request correlation uses `request_id` ([0021](0021-structured-logging.md)); its format should be compatible with W3C `traceparent` so adopting tracing later does not break correlation.

## Consequences

- Every alert listed has a scrape target or log stream behind it, so the alert set is deliverable rather than aspirational.
- About ten observability containers run in every environment, including on developer machines.
- Until the uptime check runs elsewhere, a host outage silences all monitoring.

## Open questions

- Concrete thresholds for error rate, latency and authentication anomalies. These start as guesses and are tuned after observing normal behaviour.
