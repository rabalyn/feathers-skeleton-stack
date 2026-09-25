# 0025: Operational settings are runtime settings in PostgreSQL, seeded with defaults and edited by admins

- Status: Accepted
- Date: 2026-09-24
- Scope: Required (v1)
- Related: [0005](0005-typebox-schema-boundary.md), [0006](0006-feathersjs-typescript-api.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0016](0016-nginx-and-tls-everywhere.md), [0017](0017-nfs-backup-storage.md), [0020](0020-object-storage-uploads.md), [0024](0024-background-jobs-bullmq.md)

## Context

Retention periods, quotas, limits and schedules change more often than code, differ between products built on the skeleton, and should be adjustable by an administrator without a release or a restart. Environment configuration fails all three: it needs a deployment to change and is invisible to the application's audit trail.

## Decision

### What is a runtime setting

Every operational policy the application or its own services enforce is a runtime setting stored in PostgreSQL:

| Setting | Key | Default | Used by |
| --- | --- | --- | --- |
| Audit event retention | `auditRetentionDays` | 90 days | Worker ([0013](0013-gdpr-export-and-retention.md)) |
| Expired session retention | `expiredSessionRetentionDays` | 30 days after family expiry | Worker |
| Data export retention | `exportRetentionDays` | 7 days | Worker |
| Soft-deleted object purge delay | `objectPurgeDelayDays` | 32 days | Worker ([0020](0020-object-storage-uploads.md)) |
| Refresh reuse grace window | `refreshGraceSeconds` | 10 seconds | API ([0010](0010-sessions-postgres-ratelimits-valkey.md)) |
| Session idle timeout | `sessionIdleSeconds` | 8 hours | API ([0010](0010-sessions-postgres-ratelimits-valkey.md)) |
| Session absolute lifetime | `sessionAbsoluteSeconds` | 7 days | API ([0010](0010-sessions-postgres-ratelimits-valkey.md)) |
| Maximum upload size | `maxUploadBytes` | 8 MiB, below the 10 MiB Nginx ceiling | API ([0020](0020-object-storage-uploads.md)) |
| Storage quota per user | `userQuotaBytes` | 100 MB | API |
| Storage quota total | `totalQuotaBytes` | 5 GB | API |
| Backup schedule | `backupSchedule` | Daily, as the cron expression `0 3 * * *` | Backup service ([0017](0017-nfs-backup-storage.md)) |
| Backup retention | `backupRetentionDailySnapshots` | 31 daily snapshots | Backup service |
| Rate limit, SAML login start | `rateLimitSamlLoginPerMinute` | 60 per client IP and minute | API ([0010](0010-sessions-postgres-ratelimits-valkey.md)) |
| Rate limit, SAML ACS | `rateLimitSamlAcsPerMinute` | 60 per client IP and minute | API |
| Rate limit, refresh | `rateLimitRefreshPerMinute` | 600 per client IP and minute | API |
| Feature flags | `featureFlags` | None (an empty map of name to boolean) | API |
| Maintenance mode | `maintenanceMode` | Off | API |

Durations are whole seconds or days and sizes are bytes, as each key's name says.

What stays **deployment configuration** is what the application cannot or should not change about its surroundings: host names, endpoints, secret file paths, Loki and Prometheus retention (their own configuration files), the Nginx body size ceiling, and Grafana alert rules and recipients (provisioned as code, [0022](0022-observability-and-alerting.md)).

### Storage and validation

- One `settings` table: a key, a JSON value, and who changed it when. Every key has a TypeBox schema in one registry module ([0005](0005-typebox-schema-boundary.md)); a value that does not match its schema is rejected on write.
- **Cross-setting rules** are validated on write, in the settings service, and rejected with a validation error:
  - the object purge delay must exceed the backup retention,
  - the maximum upload size must stay below the Nginx ceiling, which the API receives as deployment configuration (`BODY_SIZE_CEILING_BYTES`, Nginx's `client_max_body_size` in bytes),
  - the session idle timeout must not exceed the absolute lifetime.
- The settings service changes one key per call, locks the settings rows while it checks the rules, so two changes that are each valid cannot together break one, and commits the change with its audit event ([0013](0013-gdpr-export-and-retention.md)).
- Every change is an audit event.

### Seeding

- Every key, its schema and its default are declared in the registry module. Every key of the table above is registered from the start, including those whose consumer does not exist yet.
- Each deployment's `migrate` job, after the migrations, inserts every registered key it does not find, with its default. It never overwrites an existing value. A release that adds a key therefore needs no migration of its own, and a new environment is fully seeded by its first `migrate` run.
- The **bootstrap**, once it exists, relies on that rather than seeding separately.
- The API, the worker and the backup service **refuse to start** if a key they need is missing. An environment therefore cannot run with a policy silently absent, which is what the previous "required configuration" rule protected.

### Access

Only `admin` reads and writes settings through the UI; `operator` and `user` see none of them ([0011](0011-casl-role-authorization.md)). The backup service reads them through its read-only database role. Consumers cache values in process for **30 seconds**, so a change takes effect within that interval without a restart; the API process that made a change drops its own cache at once. A stored value that no longer matches its schema is treated like a missing one.

## Consequences

- Retention, quotas and schedules change without a release, with an audit trail of who changed what.
- Two rules span a setting and deployment configuration or another setting; they are enforced in one service, not scattered.
- The backup alert's time window is code while the backup schedule is a setting, so they must be changed together ([0022](0022-observability-and-alerting.md)).
- Settings are data, so they are included in database backups and restored with them.
