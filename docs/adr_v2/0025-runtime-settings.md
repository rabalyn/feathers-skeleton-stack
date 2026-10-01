# 0025: Operational settings are runtime settings in PostgreSQL, seeded with defaults and edited by admins

- Status: Accepted
- Date: 2026-09-24
- Scope: Required (v1)
- Related: [0005](0005-typebox-schema-boundary.md), [0006](0006-feathersjs-typescript-api.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0016](0016-nginx-and-tls-everywhere.md), [0017](0017-nfs-backup-storage.md), [0020](0020-object-storage-uploads.md), [0024](0024-background-jobs-bullmq.md), [0028](0028-read-only-view-as.md), [0029](0029-api-tokens.md)

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
| Rate limit, break-glass password login | `rateLimitPasswordLoginPerMinute` | 5 per account, client IP and minute | API ([0008](0008-authentication-saml2-ldap.md)) |
| Mail sending limit, count | `mailSendLimitCount` | 10 mails per window, across all worker processes | Worker ([0027](0027-email-templates-and-sending.md)) |
| Mail sending limit, window | `mailSendLimitWindowSeconds` | 300 seconds | Worker |
| Mail delivery log retention | `mailDeliveryRetentionDays` | 90 days | Worker ([0027](0027-email-templates-and-sending.md)) |
| Feature flags | `featureFlags` | None (an empty map of name to boolean) | API |
| Maintenance mode | `maintenanceMode` | Off | API, worker, browser (see *Maintenance mode*) |
| View-as lifetime | `viewAsMinutes` | 30 minutes | API ([0028](0028-read-only-view-as.md)) |

Durations are whole seconds or days and sizes are bytes, as each key's name says.

What stays **deployment configuration** is what the application cannot or should not change about its surroundings: host names, endpoints, secret file paths, Loki and Prometheus retention (their own configuration files), the Nginx body size ceiling, and Grafana alert rules and recipients (provisioned as code, [0022](0022-observability-and-alerting.md)).

The **public origin** (`PUBLIC_ORIGIN`) is one of those host names, and stays one. Decided 2026-10-02, when a runtime setting for the app's public address was considered: the same value builds every link the application hands out, mails included ([0027](0027-email-templates-and-sending.md)), and is the Origin check, the access token's audience and issuer ([0010](0010-sessions-postgres-ratelimits-valkey.md)) and the SAML entity ID the IdP is configured for ([0008](0008-authentication-saml2-ldap.md)). Splitting off a setting for the links would let the two drift apart, and moving all of it into the database would let one wrong value lock everyone out, the break-glass account included, until somebody edits the row by hand. It is defined once in `compose.yaml` (the `&public-origin` anchor), which the worker and `scripts/stack.sh` take it from; the IdP realm and the uptime probe repeat it. The system-info page shows it read-only ([0032](0032-system-info-and-update-check.md)).

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

Settings are read and written through the UI under the `settings.manage` permission, which only `admin` holds as seeded; `operator` and `user` see none of them unless an admin grants it ([0011](0011-casl-role-authorization.md)). The backup service reads them through its read-only database role. Consumers cache values in process for **30 seconds**, so a change takes effect within that interval without a restart; the API process that made a change drops its own cache at once. A stored value that no longer matches its schema is treated like a missing one.

**Every key is explained on the Settings page.** Decided 2026-10-02: an info icon next to each key shows what it means and what it must agree with in a tooltip, on hover and on keyboard focus, and the edit dialog repeats the text. The texts are user-facing, so they live in the web app's catalogues under `settings.help.<key>`, in every locale ([0014](0014-frontend-quasar-vue.md)); a unit test fails when a registered key lacks one or a text names a key the registry no longer has. A product that adds a key adds its text with it.

### Maintenance mode

Decided 2026-09-30. An admin switches maintenance mode on and off on the Settings page, after a confirmation. It exists so the application can be taken down for work on it while those who do the work still use it.

- **Who is let in**: holders of `settings.manage` ([0011](0011-casl-role-authorization.md)), exactly those who can switch the mode off again, so a role cannot lock itself out; in a view-as, the one looking decides ([0028](0028-read-only-view-as.md)). The break-glass account holds it as an admin ([0008](0008-authentication-saml2-ldap.md)).
- **Switching it on** revokes every active session of everyone else, and their sockets close with it ([0010](0010-sessions-postgres-ratelimits-valkey.md), [0012](0012-role-scoped-channels.md)). Switching it off ends nothing. Both are audit events of their own (`maintenance.enable` with the number of sessions ended, `maintenance.disable`), beside the setting's `settings.update`.
- **While it is on**, every service call of anyone else is answered **503 with `data.maintenance: true`**, whatever the transport, and so is every **API token**, an admin's included ([0029](0029-api-tokens.md)). The authentication service answers a refresh the same way, with or without a session, so a browser learns why it is not let in; a refresh, password login or socket authentication that succeeds for somebody else is undone and its session revoked. A wrong break-glass password stays a plain 401.
- **Login stays reachable.** The ACS cannot tell who logs in before the IdP answers, so the login page and the SAML login start stay open to everyone; the ACS refuses anyone else after the assertion, records `login.refused` with the reason `maintenance`, and redirects to the web app's maintenance page, `/maintenance`.
- **The worker stops working**: it looks at the setting every 15 seconds, lets each running job finish and takes no further one until the mode is off ([0024](0024-background-jobs-bullmq.md)). Jobs, schedules included, wait in their queues meanwhile. A paused worker counts as live. The backup service is not affected and keeps its schedule ([0017](0017-nfs-backup-storage.md)).
- **The browser**: `GET /api/maintenance` answers `{ active }` to anyone, uncached, and 503 when the database cannot say. A 503 with `data.maintenance` from any call or refresh, or an API that does not answer at all, takes the browser to the public `/maintenance` page: the API is expected to be down for part of the window, and then the browser cannot learn more. That page polls the state every **30 seconds**; once the API answers and the mode is off, it reloads the application at the login page. An admin sees a banner while the mode is on.
- Like every setting, other API processes follow within the cache interval above. Sessions are revoked in the database at once, so a process with a stale cache still refuses the ended sessions.

## Consequences

- Retention, quotas and schedules change without a release, with an audit trail of who changed what.
- Two rules span a setting and deployment configuration or another setting; they are enforced in one service, not scattered.
- The backup alert's time window is code while the backup schedule is a setting, so they must be changed together ([0022](0022-observability-and-alerting.md)).
- Settings are data, so they are included in database backups and restored with them. That includes maintenance mode: a backup taken while it was on restores with it on.
