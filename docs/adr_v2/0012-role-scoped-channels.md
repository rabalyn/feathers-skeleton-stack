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
  - events concerning configuration or runtime state publish only to `roles/admin`, mirroring the matrix in [0011](0011-casl-role-authorization.md), where configuration is the admin's alone.
- Channel membership is a **projection of the CASL ability**, not a parallel rule set. `feathers-casl`'s channel helpers filter each outgoing event against the receiving connection's ability, so a connection cannot receive a record, or a field of a record, that a direct request would have denied it.
- Every event payload passes through the same external resolver as the REST response ([0005](0005-typebox-schema-boundary.md)). There is no separate serialisation path for real-time. The channel helpers are handed the resolved payload, never the service's internal result, because the per-connection copy they produce is what goes on the wire.
- A publisher only names candidate channels; the ability filter is what decides. A service without a publisher, and every event of the authentication service, reaches nobody. When filtering fails, the event reaches nobody as well (`feathers-casl`'s default would fall back to every authenticated connection).
- Membership is recomputed whenever the connection re-authenticates. When a session is revoked or a role changes, the connection is dropped from its channels and forced to re-authenticate, so an in-flight socket cannot outlive the permissions it was granted under ([0010](0010-sessions-postgres-ratelimits-valkey.md)).
  - The triggers are: a patch of a user's `role` or `enabled`, which ends every connection of that user, and a revoked session (logout, refresh token reuse), which ends that session's connections.
  - Forcing means the server **closes the socket**. The client reconnects when the server closed it, re-authenticates with its access token and, when that is refused, refreshes first; a disabled account or a revoked session then ends in the anonymous state. A socket whose access token expires unrenewed is closed the same way, by Feathers.
  - Session expiry (idle or absolute) is not a trigger: every call re-checks the session anyway, and the access token lifetime bounds how long an expired session's socket keeps receiving events.
- Connections and channels live in the one API process ([0002](0002-service-inventory-and-networks.md)). The worker's first job, retention cleanup, changes nothing a connection is shown. A change made by the worker ([0024](0024-background-jobs-bullmq.md)) reaches the channels through the api: the worker writes its result to PostgreSQL, the api listens to the queue's events (BullMQ `QueueEvents`, within the `bull:*` keys its Valkey user already reaches), re-reads the row and writes the same values again through the service as an internal `patch`. That publishes the change like any other, with the usual resolvers and per-connection abilities. An event the api misses, while it restarts say, loses only the notification: the row is already correct, and the next read shows it. The GDPR export is the first job that works this way ([0013](0013-gdpr-export-and-retention.md)).

## Consequences

- Authorization is expressed once and applied to both delivery paths, which is the only arrangement that stays correct as rules change.
- Publishers must be written for every service that emits events; a service without one emits to nobody, which is the safe default.
- A role change causes a visible reconnect in the client. Acceptable, and preferable to a socket retaining stale rights.

## Open questions

- Whether the frontend needs any real-time service beyond the document list in the skeleton domain model ([0009](0009-tu-id-identity-model.md)). Add publishers as real screens appear, not speculatively.
