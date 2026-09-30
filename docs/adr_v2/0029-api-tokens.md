# 0029: API tokens for scripts, owned by a person and bounded by their rights

- Status: Accepted
- Date: 2026-09-30
- Scope: Required (v1)
- Related: [0005](0005-typebox-schema-boundary.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0013](0013-gdpr-export-and-retention.md), [0017](0017-nfs-backup-storage.md), [0018](0018-owasp-security-baseline.md), [0021](0021-structured-logging.md), [0028](0028-read-only-view-as.md)

## Context

Every credential so far belongs to a browser login ([0010](0010-sessions-postgres-ratelimits-valkey.md)): a SAML assertion or the break-glass password opens a session, whose access token lasts 15 minutes and is refreshed through an `HttpOnly` cookie. A script cannot hold that, so reading from the API outside a browser needs a long-lived credential of its own.

The alternatives were a service account (a principal of its own, whose permissions are fixed when the token is made) and a personal token (owned by the person who made it and never worth more than that person's rights). A service account lets whoever may create one mint rights they do not hold, unless creation is fixed to `admin`, which the request ruled out: creating tokens is to be grantable like any other permission. Personal tokens were chosen. Decided 2026-09-30.

## Decision

### The credential

- An **API token** is `apt_` followed by 32 random bytes in base64url. The prefix tells it apart from an access token and gives secret scanners a pattern to match. It is shown **once**, in the answer to its creation, and stored only as its **SHA-256**. At 256 bits nobody can guess it, so a slow hash like the break-glass password's argon2id would buy nothing and cost a hash per request. Its last four characters are kept as a hint, so its owner can tell tokens apart.
- An `api_tokens` row holds the owner's surrogate id, a name, the hash, the hint, the chosen **catalogue permission keys** (at least one), the creation time, an optional expiry and the last use, which moves at most once a minute.
- It is sent as `Authorization: Bearer apt_…` on **REST requests only**. It opens no session and yields no access token: the authentication service does not accept it (it is not in `authStrategies`, only in `parseStrategies`), so no WebSocket authenticates with it and it joins no channel ([0012](0012-role-scoped-channels.md)).
- The **expiry is optional**. A token without one lasts until it is revoked, its owner is disabled or erased, or its owner loses `api-tokens.create`.

### What a token may do

- Its ability is built on every request, like a session's ([0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md)), from **the permissions chosen for it that its owner still holds**. Writes are included where those permissions grant them. So a token never exceeds its owner's current rights, and a change to the owner's roles, or to what they grant, applies to the token on its next request.
- A token has **no baseline**: not the owner's own record, avatar, files, export or activity. It has exactly what was chosen for it. Nor does it have role management, which is not a catalogue permission.
- Some permissions may **never be put on a token**, and asking for them is a **400**:
  - `api-tokens.create` and `api-tokens.manage`, so that a leaked token cannot mint successors that survive its revocation;
  - `users.view-as`, which is state of a browser session ([0028](0028-read-only-view-as.md));
  - `erasures.create` and `settings.manage`, which need a person in the UI.
- A token is accepted only while its owner is enabled and **holds `api-tokens.create`**, checked on every request. Withdrawing that permission stops every token the person has, at once; restoring it brings back those not revoked meanwhile. An unknown, expired or thus disabled token is a **401**. While maintenance mode is on, every token is a **503**, an admin's included ([0025](0025-runtime-settings.md)).

### Creating, seeing and revoking

- `api-tokens.create` creates tokens of one's own. It is a catalogue permission, so `admin` holds it and no seeded role does until an admin grants it ([0011](0011-casl-role-authorization.md)). A token carries only permissions its creator holds when creating it; any other is a **403**.
- Everybody sees and revokes **their own** tokens. That is part of the baseline, so a person who has lost `api-tokens.create` can still clean up. `api-tokens.manage` (seeded for nobody but `admin`) lists and revokes everybody's.
- The `api-tokens` service offers `find`, `get`, `create` and `remove`. Revoking **deletes** the row. The token is in the result of `create` and nowhere else: never in a later read, never in a published event. The `created` event carries the record without it ([0012](0012-role-scoped-channels.md)), and the hash is never selected ([0005](0005-typebox-schema-boundary.md)).
- The API tokens page lists tokens with their permissions, expiry and last use, and shows the owner to those who see everybody's. It creates a token from the permissions its user holds that a token may carry, shows the token once with a copy button, and revokes. It appears for holders of `api-tokens.create` or `api-tokens.manage`.

### Audit, logging, privacy, restore

- `api-tokens.create` (with name, permissions and expiry) and `api-tokens.revoke` are audit events ([0013](0013-gdpr-export-and-retention.md)). Calls made with a token are attributed to its owner, as the owner's own calls are; their log lines carry the token's id as `api_token_ref` beside `user_ref` ([0021](0021-structured-logging.md)).
- `api_tokens` is in the personal data registry: the person's tokens (name, permissions, dates, never the hash) are in their export, and erasure deletes them ([0013](0013-gdpr-export-and-retention.md)).
- A database restore would bring back tokens revoked after the backup. So the restore post-step deletes every API token, beside revoking every session ([0017](0017-nfs-backup-storage.md)), and owners create new ones.
- Token authentication is not rate-limited. There is nothing to guess, and a lookup costs one indexed query, like the session check. The limits of [0010](0010-sessions-postgres-ratelimits-valkey.md) protect credentials that can be guessed or that store state per attempt.

## Consequences

- Scripts read from, and where granted write to, the API over REST with a credential that is never worth more than a named person's current rights, and that stops working when that person leaves, is disabled or loses the permission.
- A token without an expiry is a standing credential. Leaking one exposes its permissions until someone notices and revokes it. The last-use time and `api_token_ref` in the logs are what show that a token is still in use, and by what.
- A restore invalidates every token. That is the price of never resurrecting a revoked one.
- Tokens get no real-time updates. A script that needs them would need a session, which is out of scope.
