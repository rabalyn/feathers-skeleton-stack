# 0063: Authenticated `/stats` API for application dashboards, separate from `/metrics`

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Observability policy](../technical-architecture.md#observability-policy)
- Related: [0017](0017-shared-contracts-package.md), [0021](0021-casl-role-authorization.md), [0024](0024-refresh-session-storage.md), [0027](0027-activity-audit-events.md), [0062](0062-prometheus-metrics.md)

## Context

Application-level statistics are useful outside Grafana, for example inside the application for administrators. Prometheus metrics aren't an authenticated application API.

## Decision

Expose an authenticated `GET /stats` resource that returns aggregate values: total users, active users, session counts, activity counts, request/error totals, and time-bucketed trends. Protect it with a dedicated admin/observability permission, and use pagination or bounded time windows when details are requested. `/metrics` (machine-readable time series for alerting) and `/stats` (authenticated application API for non-Grafana consumers) stay separate.

## Consequences

- Dashboards inside the app need no access to Prometheus.
- Two implementations of similar aggregates must stay consistent.

## ToDos

- ToDo: [Clarify] Who the "non-Grafana consumers" are: an admin page in the Vue app? Nothing in the v1 domain model (ADR 0020) mentions one. If there is no consumer yet, defer this endpoint?
- ToDo: [Contradiction] "A dedicated admin/observability permission" isn't part of the owner/admin/user role model (ADR 0021).
- ToDo: [Clarify] Source of "request/error totals": in-process counters reset on API restart, persisting them needs storage, and reading from Prometheus contradicts the stated separation. Decide.
- ToDo: [Clarify] Time windows are bounded by data retention (activity events 90 days, sessions 30 days).
- ToDo: [Clarify] Caching or rate limiting of expensive statistics queries.
- ToDo: [Clarify] Response schema lives in `packages/contracts` (ADR 0017).
