# 0012: Real-time updates through ability-scoped Feathers channels

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADR 0008 (channel portion)
- Related: [0006](0006-feathersjs-typescript-api.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0028](0028-read-only-view-as.md), [0029](0029-api-tokens.md), [0030](0030-service-generator.md)

## Context

Real-time events are a second delivery path out of the application, and it is easy for it to leak data that the REST path correctly refuses. A connection must receive exactly what its session's permissions and ownership permit, and nothing else.

## Decision

- Real-time updates use Feathers **channels**. Every authenticated connection joins channels derived from its session:
  - every connection joins `users/{id}` for its own user,
  - and `subjects/{service}` for every service its ability may read **without conditions**, field rules allowed. A connection that reads only its own records of a service reaches them through `users/{id}`.
  - Until 2026-09-29 the second channel was `roles/admin` or `roles/operator`. Roles are data now, composed of permissions and held several at once ([0011](0011-casl-role-authorization.md)), so a channel per role no longer says what a connection may read; a channel per readable service does. Decided 2026-09-29; built in slice 12.
- Anonymous connections join nothing and receive no service events. Only a session's access token attaches a connection; an API token is accepted on REST requests only and never reaches a socket ([0029](0029-api-tokens.md)).
- Each service declares a publisher that resolves an event to recipients:
  - events about a user-owned record publish to `users/{ownerId}` and `subjects/{service}`,
  - events about everything else publish to `subjects/{service}` only.
- Channel membership is a **projection of the CASL ability**, not a parallel rule set. `feathers-casl`'s channel helpers filter each outgoing event against the receiving connection's ability, so a connection cannot receive a record, or a field of a record, that a direct request would have denied it.
- Every event payload passes through the same external resolver as the REST response ([0005](0005-typebox-schema-boundary.md)). There is no separate serialisation path for real-time. The channel helpers are handed the resolved payload, never the service's internal result, because the per-connection copy they produce is what goes on the wire.
- A publisher only names candidate channels; the ability filter is what decides. Every service names its publisher, and one whose results go to the caller only, the authentication service among them, names `publishNothing` and reaches nobody; a test fails for a service without a publisher, so reaching nobody is decided rather than fallen into ([0030](0030-service-generator.md)). When filtering fails, the event reaches nobody as well (`feathers-casl`'s default would fall back to every authenticated connection).
- Publishers are added as real screens need them, not speculatively. These services publish: `users` and `documents` to the owner and their subject channel; `sessions`, `settings`, the mail templates, their revisions and campaigns, and the `queues` status event to their subject channel ([0011](0011-casl-role-authorization.md), [0025](0025-runtime-settings.md), [0027](0027-email-templates-and-sending.md), [0024](0024-background-jobs-bullmq.md)); `data-exports` to the requesting account only, since only it sees an export ([0013](0013-gdpr-export-and-retention.md)). `roles` publishes to its subject channel as well. Every other service names `publishNothing`.
- Membership is recomputed whenever the connection re-authenticates. When a session is revoked or its permissions change, the connection is dropped from its channels and forced to re-authenticate, so an in-flight socket cannot outlive the permissions it was granted under ([0010](0010-sessions-postgres-ratelimits-valkey.md)).
  - The triggers are: a change of a user's roles or `enabled`, which ends every connection of that user; a change of a role's permissions, which ends every connection of everyone holding it; a revoked session (logout, refresh token reuse), which ends that session's connections; and the start and end of view-as, which re-join the calling connection and end the session's others ([0028](0028-read-only-view-as.md)). A connection in view-as joins the target's channels under the intersected ability.
  - Forcing means the server **closes the socket**. The client reconnects when the server closed it, re-authenticates with its access token and, when that is refused, refreshes first; a disabled account or a revoked session then ends in the anonymous state. A socket whose access token expires unrenewed is closed the same way, by Feathers.
  - Session expiry (idle or absolute) is not a trigger: every call re-checks the session anyway, and the access token lifetime bounds how long an expired session's socket keeps receiving events.
- Connections and channels live in the one API process ([0002](0002-service-inventory-and-networks.md)). The worker's first job, retention cleanup, changes nothing a connection is shown. A change made by the worker ([0024](0024-background-jobs-bullmq.md)) reaches the channels through the api: the worker writes its result to PostgreSQL, the api listens to the queue's events (BullMQ `QueueEvents`, within the `bull:*` keys its Valkey user already reaches), re-reads the row and writes the same values again through the service as an internal `patch`. That publishes the change like any other, with the usual resolvers and per-connection abilities. An event the api misses, while it restarts say, loses only the notification: the row is already correct, and the next read shows it. The GDPR export is the first job that works this way ([0013](0013-gdpr-export-and-retention.md)).
- The queue view ([0024](0024-background-jobs-bullmq.md)) shows state that has no row: the api listens to every queue's events and sends a changed queue's status as the `status` event of the `queues` service, a custom event whose publisher names `subjects/queues` and whose payload passes the same ability filter. Events are coalesced to one per queue per second and are not computed while nobody is in that channel. An event missed during a reconnect is made good by the page reading the queues again once its socket has re-authenticated.

## Consequences

- Authorization is expressed once and applied to both delivery paths, which is the only arrangement that stays correct as rules change.
- Every service carries a publisher line, including those that send nothing; the ones that send nothing say why beside it.
- A role change, and a change to a role someone holds, causes a visible reconnect in their client. Acceptable, and preferable to a socket retaining stale rights.
