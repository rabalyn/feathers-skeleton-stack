# 0011: Role-based authorization with feathers-casl and a default-deny boundary

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0021, 0063
- Related: [0005](0005-typebox-schema-boundary.md), [0008](0008-authentication-saml2-ldap.md), [0009](0009-tu-id-identity-model.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0012](0012-role-scoped-channels.md), [0025](0025-runtime-settings.md)

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
| Documents | read, write, delete | read, write, delete | read, write, delete — own only |
| Sessions | read, revoke (any) | read | read, revoke — own only |
| Audit / activity events | read | read | read — own only |
| GDPR data export | trigger for any user | — | trigger for self |
| GDPR erasure | trigger | — | — |
| Runtime settings ([0025](0025-runtime-settings.md)) | read, write | — | — |
| Feature flags, maintenance mode | read, write | — | — |

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
- Field-level restrictions are enforced by the external resolver ([0005](0005-typebox-schema-boundary.md)), so a permitted read cannot leak a forbidden field.
- Because sessions are validated per request ([0010](0010-sessions-postgres-ratelimits-valkey.md)), a role change applies on the user's very next request. No token lifetime delay.
- The frontend imports the same ability definitions through the client export ([0007](0007-typed-client-from-api.md)) to hide actions the user may not take. This is presentation only; the server remains the only enforcement point.

## Consequences

- Adding a service means adding its rules to the ability definitions; the default-deny hook makes the failure mode "nobody can use it yet" rather than "everybody can".
- The matrix above is the specification for the authorization tests. Each cell should have one.
- Exactly one role per user is a simplification; a user who needs two roles' rights today requires a decision, not a workaround.
- The ability module ships to the browser, so it must not import server-only code; the boundary lint rule in [0007](0007-typed-client-from-api.md) covers it.
