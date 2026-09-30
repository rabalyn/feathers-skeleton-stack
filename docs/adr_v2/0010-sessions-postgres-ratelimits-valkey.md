# 0010: Sessions in PostgreSQL, validated per request; rate limits in Valkey

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0023, 0024, 0025, 0028
- Related: [0008](0008-authentication-saml2-ldap.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0018](0018-owasp-security-baseline.md), [0023](0023-secrets-management.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md), [0028](0028-read-only-view-as.md), [0029](0029-api-tokens.md)

## Context

A JWT that is only checked by signature stays valid until it expires, so logout, role changes and account disabling do not take effect until then. The usual reason to accept that hole is the cost of a database lookup per request. At this user count that cost is irrelevant, and paying it removes the hole entirely.

## Decision

### Sessions live in PostgreSQL and are checked on every authenticated request

- An `auth_sessions` row is one login, which is one refresh token **family**: surrogate user id, issue, idle-expiry, absolute-expiry and revocation timestamps, last-used timestamp, and coarse client metadata, and the target and expiry of a read-only view-as when one is running ([0028](0028-read-only-view-as.md)). Its id is the session id the access token carries, and it does not change when the refresh token rotates, so the per-request check stays one primary-key lookup.
- An `auth_refresh_tokens` row is one refresh token of a family: a **hash** of the token, its issue time and its rotation time. At most one row per family is current (not rotated). Never the token itself is stored.
- Every authenticated request — REST and WebSocket alike — resolves its session row and rejects the request if the session is revoked or expired or the user is disabled. The user's permissions are loaded through their roles on the same request, so the ability every request is authorized with is never older than the request ([0011](0011-casl-role-authorization.md)). The token carries no role. Decided 2026-09-29; until then it carried the one role, compared against the user record.
- Consequences of that check, all of them the point of the exercise: logout is immediate, logout-all is immediate, disabling an account is immediate, and a change of a user's roles, or of a role's permissions, takes effect on the next request rather than after the token expires.

### Two credentials, two mechanisms

- The **access token** is a JWT signed with the authentication signing secret ([0023](0023-secrets-management.md)). It carries the session id, is held **in memory only** in the browser, lasts 15 minutes, and is what the WebSocket connection authenticates with. Because the session row is checked per request, the signature proves the token was issued here; the row decides whether it is still valid.
- The **refresh token** is an opaque random value, stored server-side only as a hash. It is not a JWT and does not depend on the signing secret. It travels in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `Path=/api/authentication`, which covers both refresh and logout. The endpoint sits under the `/api` prefix like every API path ([0016](0016-nginx-and-tls-everywhere.md)).
- A login session — one refresh token family — ends after **8 hours without a refresh** (idle) or **7 days after login** (absolute), whichever comes first; after that, a new SAML login is needed. Both are runtime settings ([0025](0025-runtime-settings.md)).
- Rotating the signing secret therefore invalidates outstanding access tokens only. Clients refresh transparently and nobody is logged out. Revoking every session is a separate, explicit operation.
- Scripts use neither: they hold an **API token**, which opens no session, is accepted on REST requests only and is checked against its row and its owner's permissions on every request ([0029](0029-api-tokens.md)).

### Refresh rotation and reuse detection

- Refresh rotates the token. Presenting a rotated-away token revokes the entire family. Rotated rows are retained until the family expires, because deleting them is what silently disables reuse detection.
- A **grace window** applies: a rotated-away token presented within the window after its rotation returns the current successor instead of revoking the family. This keeps a refresh response lost to a flaky connection from logging the user out. The window is a runtime setting ([0025](0025-runtime-settings.md)), default 10 seconds; outside it, reuse revokes the family as before. Reuse detection is an audit event ([0013](0013-gdpr-export-and-retention.md)).
- To return the current successor without storing any token, successors are **derived**: a family's first token is random, and each successor is an HMAC of its predecessor under the **refresh token key**, a secret of its own delivered like every other ([0023](0023-secrets-management.md)). Inside the grace window the server follows that chain from the presented token to the family's current one and returns exactly that token, so a lost response, a retry and concurrent refreshes from one browser all end up holding the same cookie. The key is independent of the signing secret; rotating it affects only the grace path.
- Refreshes of one family are serialised by a row lock on its session, so concurrent requests see each other's rotation.
- A refresh returns the rotated token only as the cookie, never in the response body. The cookie's lifetime is what remains of the family.
- Cross-tab refreshes are serialised with the **Web Locks API** (`navigator.locks`), so ordinary races do not look like theft. It is a real mutual exclusion, and the browser releases the lock of a tab that dies; a `BroadcastChannel` only carries messages and would need an election with timeouts built on top. Server-side detection stays authoritative.
- A daily job deletes sessions whose family expired more than the retention window ago ([0013](0013-gdpr-export-and-retention.md), [0024](0024-background-jobs-bullmq.md)).

### Valkey holds rate-limit state and job queues

- Rate limits cover login attempts, superadmin password attempts and SAML ACS abuse. Password logins are keyed by **account identifier and client IP together** rather than either alone, so a third party cannot lock out a known account by failing its logins. The SAML ACS is keyed by **client IP only**, because no account is known before the assertion has been validated.
- Limited today, each per client IP: the SAML login start (every call stores an authentication request), the ACS, and refresh. Each is a fixed one-minute window whose limit is a runtime setting ([0025](0025-runtime-settings.md)), so an admin can tighten it during an incident. The break-glass password login is limited per **account and client IP together**, default **5** per minute. Over the limit the answer is **429**, with `Retry-After` on the SAML routes.
- The limits are generous by default (60, 60 and 600 per minute) because a university network puts many people behind few addresses. They start as guesses and are tuned after observing normal traffic.
- Valkey also holds the BullMQ job queues ([0024](0024-background-jobs-bullmq.md)). One instance serves both.
- Valkey **persists to disk** (AOF, plus periodic RDB snapshots). The RDB snapshot is included in the restic backup ([0017](0017-nfs-backup-storage.md)); Valkey runs with umask `0027` so the file is readable by its group, which the backup user belongs to. With AOF on, Valkey loads **only** its AOF and starts empty when it has none, whatever RDB lies next to it, so a restore installs the snapshot as the base of a new AOF (`scripts/backup.sh restore-valkey`).
- If Valkey is unreachable, affected authentication attempts are **rejected** (fail closed) with **503**, which the client treats as a transient error rather than a logout ([0014](0014-frontend-quasar-vue.md)). The API never queues commands while disconnected, so a refusal is immediate rather than a hung request, and it keeps running and reconnecting.
- Valkey listens on **TLS only**, with a certificate from the same CA as the database hops, and clients verify it ([0004](0004-pgbouncer-pools.md)); it requires a password delivered from OpenBao ([0023](0023-secrets-management.md)). Rate-limit keys contain client addresses, and queued jobs will carry more.
- Every client service has its **own Valkey ACL user**, and the default user is off. `api` reaches the rate-limit keys (`rl:`) and the queues (`bull:`), `worker` only the queues, `test` any key (test files namespace their own), and `probe` only `PING`, for the healthcheck. `@dangerous` commands are refused except `INFO`, which the client libraries need. Valkey reads its users at start, so changing a password takes a restart.
- Its memory is capped (256 MB to start) so that it fails writes, and thereby refuses attempts, rather than exhausting the host.
- `maxmemory-policy noeviction`. An evicting policy would silently drop limiter keys and queued jobs. BullMQ requires this setting as well.
- The client IP is taken from the proxy headers set by Nginx and trusted only from the proxy's address ([0016](0016-nginx-and-tls-everywhere.md)). Without that, every request appears to come from one address and an IP limit locks out everyone at once. The API recognises the proxy by resolving its container name (`TRUSTED_PROXY_HOST`, cached briefly), since container addresses are assigned dynamically; a connection from anywhere else is keyed by its own address whatever headers it sends.

Sessions stay in PostgreSQL rather than Valkey because they must be SQL-queryable for the admins' and operators' Sessions page ([0011](0011-casl-role-authorization.md)) and the GDPR export, and because the per-request check belongs next to the user record it compares against.

## Consequences

- One indexed primary-key lookup is added to every authenticated request. At the expected user count this is not measurable, and it is the explicit trade that buys immediate revocation.
- Sessions are SQL-queryable, so "which sessions does this user have" is answerable for the Sessions page and the GDPR export. Users see their own sessions only in their export, not on a screen ([0011](0011-casl-role-authorization.md)).
- Restoring a database backup restores sessions that were revoked after the backup was taken. Revoking all sessions is therefore a mandatory step after any production restore ([0017](0017-nfs-backup-storage.md)), and so is revoking every API token ([0029](0029-api-tokens.md)).
- With rate limits and queues in one Valkey, memory pressure affects both. Memory use is visible in the metrics ([0022](0022-observability-and-alerting.md)); the job volume in scope is small.
