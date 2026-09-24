# 0028: Daily maintenance job for session and activity-event cleanup

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0024](0024-refresh-session-storage.md), [0027](0027-activity-audit-events.md), [0049](0049-coordinated-object-backup.md), [0065](0065-alerting.md)

## Context

Several decisions need periodic cleanup: expired or revoked refresh sessions (ADR 0024) and activity events older than 90 days (ADR 0027). The architecture refers to "a daily cleanup" and "the daily maintenance job" without defining the job.

## Decision

A daily maintenance job deletes expired/revoked `auth_sessions` rows and activity events older than the 90-day retention.

## Consequences

- Table sizes stay bounded.
- The job needs database credentials, scheduling, and failure monitoring.

## ToDos

- ToDo: [Missing] Mechanism: an in-process scheduler in the API, a systemd timer starting a one-shot container, or `pg_cron`. Also the local/CI equivalent.
- ToDo: [Clarify] Schedule relative to the 02:00 UTC backup window and its write pause (ADR 0049), to avoid overlap.
- ToDo: [Clarify] Concurrency guard if more than one API instance ever runs (for example a PostgreSQL advisory lock, one of the session features ADR 0014 preserves).
- ToDo: [Contradiction] Deleting revoked rows can break refresh-token reuse detection (ADR 0024). Define exactly which rows are eligible.
- ToDo: [Missing] Failure alert or last-success metric (ADR 0065), and which database role the job uses (ADR 0015).
- ToDo: [Clarify] Batched deletes to avoid long locks.
