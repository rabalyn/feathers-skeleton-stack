# 0010: Sessions in PostgreSQL, validated per request; rate limits in Valkey

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0023, 0024, 0025, 0028
- Related: [0008](0008-authentication-saml2-ldap.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0018](0018-owasp-security-baseline.md), [0023](0023-secrets-management.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md)

## Context

A JWT that is only checked by signature stays valid until it expires, so logout, role changes and account disabling do not take effect until then. The usual reason to accept that hole is the cost of a database lookup per request. At this user count that cost is irrelevant, and paying it removes the hole entirely.

## Decision

### Sessions live in PostgreSQL and are checked on every authenticated request

- An `auth_sessions` table stores: surrogate user id, a **hash** of the refresh token, token family, issue/expiry/rotation/revocation timestamps, last-used timestamp, and coarse client metadata. Never the token itself.
- Every authenticated request — REST and WebSocket alike — resolves its session row and rejects the request if the session is revoked or expired, the user is disabled, or the role on the token no longer matches the role on the user record.
- Consequences of that check, all of them the point of the exercise: logout is immediate, logout-all is immediate, disabling an account is immediate, and a role change takes effect on the next request rather than after the token expires.

### Two credentials, two mechanisms

- The **access token** is a JWT signed with the authentication signing secret ([0023](0023-secrets-management.md)). It carries the session id, is held **in memory only** in the browser, lasts 15 minutes, and is what the WebSocket connection authenticates with. Because the session row is checked per request, the signature proves the token was issued here; the row decides whether it is still valid.
- The **refresh token** is an opaque random value, stored server-side only as a hash. It is not a JWT and does not depend on the signing secret. It travels in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `Path=/api/authentication`, which covers both refresh and logout. The endpoint sits under the `/api` prefix like every API path ([0016](0016-nginx-and-tls-everywhere.md)).
- Rotating the signing secret therefore invalidates outstanding access tokens only. Clients refresh transparently and nobody is logged out. Revoking every session is a separate, explicit operation.

### Refresh rotation and reuse detection

- Refresh rotates the token. Presenting a rotated-away token revokes the entire family. Rotated rows are retained until the family expires, because deleting them is what silently disables reuse detection.
- A **grace window** applies: a rotated-away token presented within the window after its rotation returns the current successor instead of revoking the family. This keeps a refresh response lost to a flaky connection from logging the user out. The window is a runtime setting ([0025](0025-runtime-settings.md)), default 10 seconds; outside it, reuse revokes the family as before.
- Cross-tab refreshes are coordinated with a `BroadcastChannel` lock so ordinary races do not look like theft. Server-side detection stays authoritative.
- A daily job deletes sessions whose family expired more than the retention window ago ([0013](0013-gdpr-export-and-retention.md), [0024](0024-background-jobs-bullmq.md)).

### Valkey holds rate-limit state and job queues

- Rate limits cover login attempts, superadmin password attempts and SAML ACS abuse. Password logins are keyed by **account identifier and client IP together** rather than either alone, so a third party cannot lock out a known account by failing its logins. The SAML ACS is keyed by **client IP only**, because no account is known before the assertion has been validated.
- Valkey also holds the BullMQ job queues ([0024](0024-background-jobs-bullmq.md)). One instance serves both.
- Valkey **persists to disk** (AOF, plus periodic RDB snapshots). The RDB snapshot is included in the restic backup ([0017](0017-nfs-backup-storage.md)).
- If Valkey is unreachable, affected authentication attempts are **rejected** (fail closed).
- `maxmemory-policy noeviction`. An evicting policy would silently drop limiter keys and queued jobs. BullMQ requires this setting as well.
- The client IP is taken from the proxy headers set by Nginx and trusted only from the proxy's address ([0016](0016-nginx-and-tls-everywhere.md)). Without that, every request appears to come from one address and an IP limit locks out everyone at once.

Sessions stay in PostgreSQL rather than Valkey because they must be SQL-queryable for the account screen and the GDPR export, and because the per-request check belongs next to the user record it compares against.

## Consequences

- One indexed primary-key lookup is added to every authenticated request. At the expected user count this is not measurable, and it is the explicit trade that buys immediate revocation.
- Sessions are SQL-queryable, so "which sessions does this user have" is answerable for both the account screen and the GDPR export.
- Restoring a database backup restores sessions that were revoked after the backup was taken. Revoking all sessions is therefore a mandatory step after any production restore ([0017](0017-nfs-backup-storage.md)).
- With rate limits and queues in one Valkey, memory pressure affects both. Memory use is visible in the metrics ([0022](0022-observability-and-alerting.md)); the job volume in scope is small.
