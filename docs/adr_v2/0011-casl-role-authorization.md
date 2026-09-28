# 0011: Role-based authorization with feathers-casl and a default-deny boundary

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0021, 0063
- Related: [0005](0005-typebox-schema-boundary.md), [0008](0008-authentication-saml2-ldap.md), [0009](0009-tu-id-identity-model.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0012](0012-role-scoped-channels.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md), [0027](0027-email-templates-and-sending.md)

## Context

Access needs to be configurable per route at a fine grain, while day-to-day reasoning happens in terms of a few named roles rather than individual rules. As a skeleton, this repository fixes the mechanism and the three base roles; each product adds rules for its own resources.

## Decision

Roles are names for sets of CASL rules. A user has exactly one role, stored on the user record.

| Role | Intent |
| --- | --- |
| `admin` | Read and write everything, including configuration and runtime behaviour |
| `operator` | Read and write operational data, but neither see nor change configuration or runtime behaviour |
| `user` | Only user-facing services, scoped to their own data |

### Permission matrix

| Resource | `admin` | `operator` | `user` |
| --- | --- | --- | --- |
| Own user record | read; write avatar | read; write avatar | read; write avatar |
| All user records | read | read | — |
| Avatars of other users | read | read | — |
| Directory lookup (LDAP) | read | read | — |
| Role assignment | read, write | — | — |
| Account enable / disable | read, write | — | — |
| Documents | read, write, delete; file: own only | read, write, delete; file: own only | read, write, delete — own only |
| Sessions | read, revoke (any) | read, without the user agent | — |
| Audit / activity events | read | read | read — own only |
| GDPR data export | trigger for any user | trigger for self | trigger for self |
| GDPR erasure | trigger | — | — |
| Runtime settings ([0025](0025-runtime-settings.md)) | read, write | — | — |
| Feature flags, maintenance mode | read, write | — | — |
| Own locale ([0027](0027-email-templates-and-sending.md)) | write | write | write |
| Mail templates, campaigns, delivery log ([0027](0027-email-templates-and-sending.md)) | read, write | — | — |
| Job queues: state, schedules, jobs ([0024](0024-background-jobs-bullmq.md)) | read | — | — |

Directory-sourced user fields are never writable by anyone in the application ([0009](0009-tu-id-identity-model.md)). Backups are not triggered through the application at all: they run on their configured schedule ([0017](0017-nfs-backup-storage.md)), and their schedule and retention are runtime settings covered by the row above.

The dividing line for `operator` is deliberate and worth stating plainly: an operator may act on data, but configuration is the admin's alone — roles, settings, flags, maintenance state are neither changed nor read by an operator. Operators observed settings until slice 3; that was dropped so that configuration has exactly one audience, over REST and over real-time events alike ([0012](0012-role-scoped-channels.md)).

### Enforcement

- `feathers-casl` defines abilities per role. Rules are declared in one module, not scattered across services.
- A **global default-deny hook** requires authentication and authorization on every service. Public endpoints are an explicit allowlist, each rate-limited where it accepts credentials:
  - `GET /api/ping`,
  - the SAML routes under `/api/auth/saml/`: metadata, login, ACS and logout,
  - the `/api/authentication` endpoint for refresh, logout and the break-glass password login.
- Health, readiness and metrics are not on the public port at all ([0022](0022-observability-and-alerting.md)), so they need no allowlist entry.
- For `find` and `get`, CASL conditions are translated into Knex query conditions, so a `user` role query is scoped to owned rows by the authorization layer rather than by each service remembering to filter.
- A read the caller is not permitted is answered exactly like a read of a record that does not exist — **404** — so a response never confirms that a record exists. A denied write on a record the caller may read is a **403**. Lists are scoped silently, as above.
- Uploads follow the rows above ([0020](0020-object-storage-uploads.md)): a file's metadata and bytes are readable by its owner, and by `operator` and `admin`, which is exactly the avatar and document rule. Everyone may upload. Only a document's owner replaces its file: an operator or admin may rename or delete someone else's document, but a `fileId` in their patch is a **403**, since attaching needs a file of the caller's own and would put the operator's file into the owner's document, where the owner could neither download it nor find it in their export ([0013](0013-gdpr-export-and-retention.md)). Decided 2026-09-28. The own avatar is written through an `avatars` service that has no user id to address, rather than through a field-restricted `users.patch` rule: feathers-casl would drop or refuse fields before schema validation and answer 404 instead of 403 for a record the caller may read.
- Field-level restrictions are enforced by the external resolver ([0005](0005-typebox-schema-boundary.md)), so a permitted read cannot leak a forbidden field. Where a role may read a record but not all of its fields, the rule is a CASL field rule in the ability module and the resolver asks the caller's ability for it: `feathers-casl` filters only the internal result, never the payload the transport sends, while its channel helpers filter each published event by that same field rule ([0012](0012-role-scoped-channels.md)).
- Sessions ([0010](0010-sessions-postgres-ratelimits-valkey.md)) are a `sessions` service over `auth_sessions` with `find`, `get` and `remove`, for admins and operators to see who is logged in; users have no access to it, not even to their own sessions, which reach them through their data export ([0013](0013-gdpr-export-and-retention.md)). It lists **active sessions only**; revoked and expired ones are in the audit log, not in the list. `remove` revokes: it sets `revoked_at`, ends the session's sockets and records `sessions.revoke`, but keeps the row, which reuse detection needs until the family expires. Operators read every session but no user agent, their own included, and revoke none. Sessions are created by logging in, not through the service, so the session store publishes its changes as the service's events: a login as `created`, a refresh as `patched`, every revocation (the service's, logout, reuse detection) as `removed`. An expiry is not an event; it drops out of the list on its next query. The Sessions page marks the viewer's own session from the access token's session id. Decided 2026-09-28.
- Because sessions are validated per request ([0010](0010-sessions-postgres-ratelimits-valkey.md)), a role change applies on the user's very next request. No token lifetime delay.
- The frontend imports the same ability definitions through the client export ([0007](0007-typed-client-from-api.md)) to hide actions the user may not take. This is presentation only; the server remains the only enforcement point.

## Consequences

- Adding a service means adding its rules to the ability definitions; the default-deny hook makes the failure mode "nobody can use it yet" rather than "everybody can".
- The matrix above is the specification for the authorization tests. Each cell should have one.
- Exactly one role per user is a simplification; a user who needs two roles' rights today requires a decision, not a workaround.
- The ability module ships to the browser, so it must not import server-only code; the boundary lint rule in [0007](0007-typed-client-from-api.md) covers it.
