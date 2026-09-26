# 0024: Background jobs on BullMQ in a dedicated worker container

- Status: Accepted
- Date: 2026-09-24
- Scope: Required (v1)
- Related: [0002](0002-service-inventory-and-networks.md), [0004](0004-pgbouncer-pools.md), [0006](0006-feathersjs-typescript-api.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0013](0013-gdpr-export-and-retention.md), [0020](0020-object-storage-uploads.md), [0021](0021-structured-logging.md), [0022](0022-observability-and-alerting.md), [0025](0025-runtime-settings.md)

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
- The worker has the API's internal listener ([0022](0022-observability-and-alerting.md)): `/health/live` answers while its BullMQ worker runs, and the container healthcheck calls it. `/metrics` joins it with observability. The worker refuses to start without the runtime settings its jobs read.

### Jobs in the skeleton

| Job | Trigger | Does |
| --- | --- | --- |
| Retention cleanup | Daily | Deletes audit events and expired sessions past their retention ([0013](0013-gdpr-export-and-retention.md)) |
| Export expiry | Daily | Deletes generated exports past their retention |
| Object purge | Daily | Purges soft-deleted objects past the purge delay, object first, then its row; soft-deletes stored files nobody attached within 24 hours; removes uploads that never finished (`pending` for over an hour) ([0020](0020-object-storage-uploads.md)) |
| Data export | On request | Builds a GDPR export into the `exports` bucket |

Backups are not BullMQ jobs: the backup service is isolated from Valkey and schedules itself ([0017](0017-nfs-backup-storage.md)).

## Consequences

- Retries, job history and queue metrics are available from the first job, and adding bulk mail later is a new queue, not a new mechanism.
- Enqueueing is not part of the database transaction. A job enqueued after a commit can be lost if the process dies in between; a job enqueued before commit can run for a write that rolled back. Maintenance jobs are unaffected because they are schedules, not consequences of writes. Where a product needs exactly-once hand-off (mail after a write, for example), it adds a transactional outbox table then.
- Valkey is now durable state and part of the backup, and its availability affects both logins (fail-closed rate limits) and jobs.
