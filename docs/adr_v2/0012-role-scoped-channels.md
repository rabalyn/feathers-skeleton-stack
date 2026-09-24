# 0012: Real-time updates through role-scoped Feathers channels

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADR 0008 (channel portion)
- Related: [0006](0006-feathersjs-typescript-api.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md)

## Context

Real-time events are a second delivery path out of the application, and it is easy for it to leak data that the REST path correctly refuses. A connection must receive exactly what its session's role and ownership permit, and nothing else.

## Decision

- Real-time updates use Feathers **channels**. Every authenticated connection joins channels derived from its session:
  - every connection joins `users/{id}` for its own user,
  - `admin` connections additionally join `roles/admin`,
  - `operator` connections additionally join `roles/operator`.
- Anonymous connections join nothing and receive no service events.
- Each service declares a publisher that resolves an event to recipients:
  - events about a user-owned record publish to `users/{ownerId}` and `roles/admin`,
  - events an operator is permitted to see additionally publish to `roles/operator`,
  - events concerning configuration or runtime state publish only to `roles/admin`, mirroring the matrix in [0011](0011-casl-role-authorization.md).
- Channel membership is a **projection of the CASL ability**, not a parallel rule set. `feathers-casl`'s channel helpers filter each outgoing event against the receiving connection's ability, so a connection cannot receive a record, or a field of a record, that a direct request would have denied it.
- Every event payload passes through the same external resolver as the REST response ([0005](0005-typebox-schema-boundary.md)). There is no separate serialisation path for real-time.
- Membership is recomputed whenever the connection re-authenticates. When a session is revoked or a role changes, the connection is dropped from its channels and forced to re-authenticate, so an in-flight socket cannot outlive the permissions it was granted under ([0010](0010-sessions-postgres-ratelimits-valkey.md)).

## Consequences

- Authorization is expressed once and applied to both delivery paths, which is the only arrangement that stays correct as rules change.
- Publishers must be written for every service that emits events; a service without one emits to nobody, which is the safe default.
- A role change causes a visible reconnect in the client. Acceptable, and preferable to a socket retaining stale rights.

## Open questions

- Whether the frontend needs any real-time service beyond the document list in the skeleton domain model ([0009](0009-tu-id-identity-model.md)). Add publishers as real screens appear, not speculatively.
