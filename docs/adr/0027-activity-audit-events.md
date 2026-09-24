# 0027: Record minimal, successful activity events with 90-day retention

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0024](0024-refresh-session-storage.md), [0028](0028-daily-maintenance-job.md), [0062](0062-prometheus-metrics.md), [0063](0063-stats-endpoint.md)

## Context

Dashboards need "active users" and activity counts. Logging every request is too noisy and privacy-sensitive.

## Decision

- Record explicit audit events for successful, meaningful domain operations such as login, upload, create/update/delete, and export. Token refreshes and ordinary read/poll requests are **not** activity events.
- Retain events for **90 days**; the daily maintenance job removes older ones (ADR 0028).
- Store only minimal metadata: user ID, action, service/resource type, success, timestamp, request ID, and coarse result metadata. Never store request bodies, object contents, tokens, or other sensitive values.
- **Active users** are users with at least one successful authenticated activity event in the selected period.
- Activity metrics use only a fixed allowlist of action and service labels. They never include user IDs, email addresses, object keys, or arbitrary label values.

## Consequences

- Activity statistics come from a small, privacy-conscious table.
- Every meaningful operation needs an explicit hook or call to record an event.

## ToDos

- ToDo: [Contradiction] Only "successful" events are recorded, yet the stored fields include `success`. Either failures are recorded too, or the field is redundant.
- ToDo: [Clarify] Naming: with 90-day deletion these are activity/analytics records, not a compliance audit trail. Confirm that nothing (role changes, deletions, admin actions) needs longer or tamper-evident retention.
- ToDo: [Clarify] Storage location. PostgreSQL is implied (the S3 section says activity records belong in PostgreSQL), but table name and schema aren't defined.
- ToDo: [Clarify] Write path: same transaction as the domain change, or a best-effort after-hook? What happens when the event insert fails?
- ToDo: [Clarify] Whether `login` counts as an "authenticated activity" for active users, given it happens before authentication completes.
- ToDo: [Clarify] "Export" here means the user-facing export feature, not the backup object export (ADR 0046).
- ToDo: [Clarify] Where the action/service allowlist is defined (for example `packages/contracts`) and how it changes.
- ToDo: [Clarify] The "selected period" for active users can't exceed the 90-day retention; `/stats` must enforce this bound (ADR 0063).
- ToDo: [Clarify] What happens to events of deleted users (keep, delete, pseudonymize).
