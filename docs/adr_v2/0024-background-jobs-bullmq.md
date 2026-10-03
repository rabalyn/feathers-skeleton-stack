# 0024: Background jobs on BullMQ in a dedicated worker container

- Status: Accepted
- Date: 2026-09-24
- Scope: Required (v1)
- Related: [0002](0002-service-inventory-and-networks.md), [0004](0004-pgbouncer-pools.md), [0006](0006-feathersjs-typescript-api.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0013](0013-gdpr-export-and-retention.md), [0020](0020-object-storage-uploads.md), [0021](0021-structured-logging.md), [0022](0022-observability-and-alerting.md), [0025](0025-runtime-settings.md), [0027](0027-email-templates-and-sending.md)

## Context

The skeleton already has recurring work — retention deletes, session cleanup, export expiry, purging soft-deleted objects — and products built on it will add event-driven work such as bulk mail notifications. That work must not run inside request handling, must not run twice when scheduled, and must survive restarts.

The alternatives considered were in-process cron in a worker (simplest, but no retries, no job history, and a second mechanism once queues are needed), and a PostgreSQL-backed queue such as pg-boss (enqueueing is transactional with business writes, but it is weaker for high-volume sending and adds load to the system of record).

## Decision

- **BullMQ** is the job system from the start, for scheduled maintenance and for event-driven jobs alike. There is one mechanism, not two.
- Queues live in the existing **Valkey** instance, which persists to disk and is backed up ([0010](0010-sessions-postgres-ratelimits-valkey.md), [0017](0017-nfs-backup-storage.md)). No second Valkey instance.
- Jobs run in a dedicated **`worker` container**: the same image as `api`, started with a different entry point, sharing services, schemas and configuration code ([0006](0006-feathersjs-typescript-api.md)). The API only enqueues.
- Recurring jobs are BullMQ **job schedulers**, so a schedule exists once in Valkey regardless of how many worker processes run. Their intervals are runtime settings where a setting exists ([0025](0025-runtime-settings.md)). None exists for the daily jobs: they run at **03:30 Europe/Berlin**, fixed in code, and the worker re-applies its schedules on every start.
- The worker reaches PostgreSQL through PgBouncer in transaction mode like the API ([0004](0004-pgbouncer-pools.md)); maintenance jobs delete in batches, one transaction per batch.
- The worker has **credentials of its own**: the `worker` database login (a member of `app_rw`, like `app`), its own Valkey user confined to the queues ([0010](0010-sessions-postgres-ratelimits-valkey.md)), and its own `worker-agent` and AppRole ([0023](0023-secrets-management.md)). Its activity is attributable, and each credential rotates alone.
- Jobs carry the `request_id` of the request that enqueued them, so logs correlate across the hand-off ([0021](0021-structured-logging.md)). Job payloads carry surrogate ids, never direct identifiers or file contents.
- Failed jobs retry with backoff; a job that exhausts its retries logs at `error` level, which the Loki error alert picks up ([0022](0022-observability-and-alerting.md)). A job the worker does not know fails at once, without retries.
- On SIGTERM the worker stops taking jobs and gives a running job the API's **5-second** grace period ([0006](0006-feathersjs-typescript-api.md)). A job cut off keeps its lock until the lock expires; BullMQ then finds it stalled and runs it again, which maintenance jobs tolerate: each batch commits on its own, and a rerun deletes what is still due.
- The worker has the API's internal listener ([0022](0022-observability-and-alerting.md)): `/health/live` answers while its BullMQ workers run or are paused by maintenance mode, and the container healthcheck calls it. While maintenance mode is on, the worker takes no job ([0025](0025-runtime-settings.md)). `/metrics` joins it with observability. The worker refuses to start without the runtime settings its jobs read.

- **Admins see the queues in the application**, read-only, on a page updated live ([0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md)). The api's `queues` service reads each queue from Valkey: whether it is paused, its counts per state, its global rate limit and whether that is holding jobs back, its job schedulers with their next run, and its running, waiting, delayed and failed jobs, at most 50 per state, with name, id, attempts and times. Job payloads and failure messages are not shown: payloads are surrogate ids, and an error text can carry an address ([0021](0021-structured-logging.md)); the logs and the delivery log have both. The page cannot retry, remove or pause anything: retries and the outbox sweep recover work by themselves ([0027](0027-email-templates-and-sending.md)). Every queue is listed in `QUEUE_NAMES`, where a product adds its own. Trends and alerting stay with the queue metrics in Grafana ([0022](0022-observability-and-alerting.md)).

### Jobs in the skeleton

| Job | Trigger | Does |
| --- | --- | --- |
| Retention cleanup | Daily | Deletes audit events, expired sessions and mail deliveries past their retention ([0013](0013-gdpr-export-and-retention.md), [0027](0027-email-templates-and-sending.md)), and expired SAML requests and replay cache entries ([0008](0008-authentication-saml2-ldap.md)) |
| Export expiry | Daily | Deletes generated exports past their retention, object first, then its row; marks an export still pending after a day `failed` (its job was lost); removes objects in `exports` older than an hour that no row describes, which erasure leaves behind ([0013](0013-gdpr-export-and-retention.md)) |
| Object purge | Daily | Purges soft-deleted objects past the purge delay, object first, then its row; soft-deletes stored files nobody attached within 24 hours; removes uploads that never finished (`pending` for over an hour); removes objects older than a day that no row describes, which only a failure or a restore to an earlier database state leaves behind ([0020](0020-object-storage-uploads.md)) |
| Mail delivery | On a notification's commit, a campaign's send, and a sweep every minute | Renders and sends one mail on a queue of its own, `mail`, throttled to `mailSendLimitCount` per `mailSendLimitWindowSeconds`; five attempts for temporary SMTP failures ([0027](0027-email-templates-and-sending.md)) |
| Mail campaign | On an admin's send | Resolves a campaign's recipients into delivery rows and enqueues one mail delivery each ([0027](0027-email-templates-and-sending.md)) |
| Data export | On request | Builds a GDPR export into the `exports` bucket. Runs on a queue of its own, `data-exports`, one at a time, so a long daily job never delays it; three attempts with a short backoff, since someone is waiting ([0013](0013-gdpr-export-and-retention.md)) |
| Update check | Daily, once at the worker's start when the last result is older than a day, and when an admin asks for one | Compares each component's declared version with its registry's tags and end-of-life dates, from a fixed allowlist of outbound hosts and from Prometheus for the host's operating system, and stores the result ([0032](0032-system-info-and-update-check.md)) |

Backups are not BullMQ jobs: the backup service is isolated from Valkey and schedules itself ([0017](0017-nfs-backup-storage.md)).

## Consequences

- Retries, job history and queue metrics are available from the first job, and mail was a new queue, not a new mechanism ([0027](0027-email-templates-and-sending.md)).
- Enqueueing is not part of the database transaction. A job enqueued after a commit can be lost if the process dies in between; a job enqueued before commit can run for a write that rolled back. Maintenance jobs are unaffected because they are schedules, not consequences of writes. Mail after a write goes through a transactional outbox, the `mail_deliveries` table ([0027](0027-email-templates-and-sending.md)); a product needing the same guarantee for other work follows that pattern.
- Once an admin has first opened the queue view, the api holds two more Valkey connections per queue, one reading and one blocked on its events, until it stops.
- Valkey is now durable state and part of the backup, and its availability affects both logins (fail-closed rate limits) and jobs.
