# 0024: Store rotating refresh sessions in PostgreSQL `auth_sessions`

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0023](0023-hybrid-jwt-refresh-cookie.md), [0028](0028-daily-maintenance-job.md), [0052](0052-restore-drills.md), [0062](0062-prometheus-metrics.md), [0063](0063-stats-endpoint.md)

## Context

Refresh credentials must be revocable, rotated, and able to detect theft through token reuse. Session counts also feed application statistics.

## Decision

- Refresh sessions live in a PostgreSQL `auth_sessions` table. Store only a **hash** of each refresh token, plus user ID, token family, expiry, rotation and revocation timestamps, last-used timestamp, and limited user-agent/IP metadata.
- Add indexes for token lookup, user/session statistics, and expiry cleanup.
- **Rotate** the refresh token on every refresh. **Reuse** of an old token revokes the whole token family.
- Coordinate browser refreshes across tabs with a client-side lock or `BroadcastChannel` so ordinary races don't look like theft. Server-side reuse detection stays authoritative.
- Allow unlimited sessions per user initially.
- A daily cleanup removes expired/revoked rows (ADR 0028).
- Revoke all sessions when a password changes or an account is disabled.
- An **active session** is a non-revoked, unexpired `auth_sessions` row. `/stats` and the Prometheus business metrics use the same definition.

## Consequences

- A stolen refresh token is detected on the legitimate client's next refresh.
- The database is written on every refresh, roughly every 4 minutes per active client.
- Session metadata is personal data and needs a retention rule.

## ToDos

- ToDo: [Contradiction] Reuse detection needs superseded token hashes to exist until the family expires, but the daily cleanup deletes "expired/revoked rows". If rotated rows count as revoked and are deleted, an old token looks like an unknown token and theft detection silently stops. Define row retention (for example keep rotated rows until family expiry).
- ToDo: [Clarify] Schema granularity: one row per session (current hash updated on rotation, previous hashes kept elsewhere?) or one row per issued token? With one row per token, "active session = non-revoked, unexpired row" over-counts unless rotated rows are marked.
- ToDo: [Clarify] There is no reuse grace window. If a refresh response is lost (network drop, mobile client), the retry uses the old token and the whole family is revoked. Locks and `BroadcastChannel` only cover tabs in the same browser profile. Choose a short grace period or accept forced logouts.
- ToDo: [Clarify] What "limited user-agent/IP metadata" contains (truncated IP? full user agent?), how long it is kept, and on what legal basis.
- ToDo: [Clarify] Whether "unlimited sessions per user" needs a safety ceiling against table growth from scripted logins, which only the login rate limits (ADR 0025) currently restrict.
- ToDo: [Clarify] Whether "revoke all sessions when a password changes" includes the session that made the change, and whether password reset counts (ADR 0026).
- ToDo: [Missing] Restoring a database backup brings back sessions that were revoked after the backup was taken. Revoke all sessions (or rotate the JWT signing key) as a mandatory post-restore step (ADR 0052).
- ToDo: [Clarify] An "active session" counts sessions unused for up to 30 days, so it isn't a measure of actual use. Confirm that is the intended metric semantics.
- ToDo: [Clarify] Also index `token_family` for family-wide revocation.
