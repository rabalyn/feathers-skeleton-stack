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

| Setting | Default | Used by |
| --- | --- | --- |
| Audit event retention | 90 days | Worker ([0013](0013-gdpr-export-and-retention.md)) |
| Expired session retention | 30 days after family expiry | Worker |
| Data export retention | 7 days | Worker |
| Soft-deleted object purge delay | 32 days | Worker ([0020](0020-object-storage-uploads.md)) |
| Refresh reuse grace window | 10 seconds | API ([0010](0010-sessions-postgres-ratelimits-valkey.md)) |
| Maximum upload size | Set at implementation, below the Nginx ceiling | API ([0020](0020-object-storage-uploads.md)) |
| Storage quota per user | 100 MB | API |
| Storage quota total | 5 GB | API |
| Backup schedule | Daily | Backup service ([0017](0017-nfs-backup-storage.md)) |
| Backup retention | 31 daily snapshots | Backup service |
| Feature flags, maintenance mode | Off | API |

What stays **deployment configuration** is what the application cannot or should not change about its surroundings: host names, endpoints, secret file paths, Loki and Prometheus retention (their own configuration files), the Nginx body size ceiling, and Grafana alert rules and recipients (provisioned as code, [0022](0022-observability-and-alerting.md)).

### Storage and validation

- One `settings` table: a key, a JSON value, and who changed it when. Every key has a TypeBox schema in one registry module ([0005](0005-typebox-schema-boundary.md)); a value that does not match its schema is rejected on write.
- **Cross-setting rules** are validated on write, in the settings service, and rejected with a validation error:
  - the object purge delay must exceed the backup retention,
  - the maximum upload size must stay below the Nginx ceiling, which the API receives as deployment configuration.
- Every change is an audit event.

### Seeding

- The **bootstrap** fills every key with its default when an environment is first set up.
- Each deployment's `migrate` job inserts keys introduced by that release, with their defaults. It never overwrites an existing value.
- The API, the worker and the backup service **refuse to start** if a key they need is missing. An environment therefore cannot run with a policy silently absent, which is what the previous "required configuration" rule protected.

### Access

`admin` reads and writes settings through the UI; `operator` reads them ([0011](0011-casl-role-authorization.md)). The backup service reads them through its read-only database role. Consumers cache values briefly in process, so a change takes effect within that interval without a restart.

## Consequences

- Retention, quotas and schedules change without a release, with an audit trail of who changed what.
- Two rules span a setting and deployment configuration or another setting; they are enforced in one service, not scattered.
- The backup alert's time window is code while the backup schedule is a setting, so they must be changed together ([0022](0022-observability-and-alerting.md)).
- Settings are data, so they are included in database backups and restored with them.
