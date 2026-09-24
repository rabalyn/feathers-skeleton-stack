# 0060: Separate private liveness and readiness endpoints

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (before first production release)
- Source: [Technical architecture › Observability policy, Production, PgBouncer](../technical-architecture.md#observability-policy)
- Related: [0014](0014-pgbouncer-session-pooling.md), [0025](0025-authentication-rate-limiting.md), [0032](0032-external-nginx-ingress.md), [0039](0039-release-procedure-and-rollback.md), [0049](0049-coordinated-object-backup.md)

## Context

Process supervision, release validation, and monitoring need to tell "the process is running" apart from "the service can handle requests".

## Decision

- `GET /health/live` only confirms that the API process is running.
- `GET /health/ready` verifies that required dependencies, such as PgBouncer, are reachable.
- Deployment and monitoring checks call both endpoints internally. External Nginx doesn't route them.
- Health and readiness endpoints exist before the first production release.

## Consequences

- Restart decisions use liveness; traffic and release decisions use readiness.

## ToDos

- ToDo: [Clarify] The readiness dependency list says only "such as PgBouncer". Should Valkey (authentication fails closed without it) and S3 be included? Failing readiness on Valkey would mark the whole API unready even though reads still work.
- ToDo: [Contradiction] The endpoints are "private", yet they are served on the same listener that external Nginx proxies publicly (ADR 0032).
- ToDo: [Clarify] Consumers: Quadlet `HealthCmd` (which needs an HTTP client in the API image), the release script, Prometheus. Say which endpoint each uses and whether an unhealthy state restarts the container.
- ToDo: [Clarify] What readiness reports during the backup write pause (ADR 0049) and during migrations.
- ToDo: [Missing] Health-check definitions for web, PgBouncer, Valkey, S3, and the observability services.
