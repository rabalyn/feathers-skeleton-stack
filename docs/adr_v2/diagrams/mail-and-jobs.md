# Mail and background jobs

Illustrates [0024](../0024-background-jobs-bullmq.md), [0027](../0027-email-templates-and-sending.md) and the update check of [0032](../0032-system-info-and-update-check.md). Where this page and an ADR or the code disagree, the ADR and the code win.

The API only enqueues; the worker runs every job. Both reach Valkey on `app-data`, each with its own ACL user (`api`: `rl:` and `bull:` keys, `worker`: `bull:` only).

## Queues

```mermaid
flowchart LR
  api["api"]
  sched(["BullMQ job schedulers<br>daily 03:30 Europe/Berlin,<br>mail sweep every minute"])

  subgraph valkey["valkey :6379 (app-data)"]
    qMaint[["maintenance"]]
    qMail[["mail<br>global rate limit from settings"]]
    qExport[["data-exports<br>concurrency 1"]]
  end

  subgraph worker["worker"]
    retention["retention cleanup"]
    expiry["export expiry"]
    purge["object purge"]
    sweep["mail outbox sweep"]
    campaign["mail campaign"]
    update["update check"]
    deliver["mail delivery"]
    exportJob["data export"]
  end

  api -->|"after commit"| qMail
  api -->|"admin sends a campaign,<br>admin runs the update check"| qMaint
  api -->|"export requested"| qExport
  sched --> qMaint

  qMaint --> retention & expiry & purge & sweep & campaign & update
  qMail --> deliver
  qExport --> exportJob

  sweep -->|"deliveries pending > 1 min"| qMail
  sweep -->|"campaigns pending > 1 min"| qMaint
  campaign -->|"one job per recipient"| qMail

  retention & expiry & purge & sweep & campaign & update & deliver & exportJob -->|"PG+TLS :6432"| pgb[("pgbouncer")]
  expiry & purge & exportJob -->|"HTTPS :3900"| s3[("s3")]
  deliver -->|"SMTP+STARTTLS :1025"| smtp["mail / university relay"]
  update -->|"HTTPS, fixed allowlist"| internet(["Docker Hub, quay.io,<br>endoflife.date"])
  update -->|"observability · HTTPS :9090<br>host OS"| prom[("prometheus")]
```

## Notification through the outbox

A mail exists exactly when the write that causes it commits.

```mermaid
sequenceDiagram
  autonumber
  participant code as Product code (api or worker)
  participant pg as postgres (via pgbouncer)
  participant vk as valkey
  participant w as worker
  participant smtp as SMTP :1025

  code->>pg: BEGIN … the write …<br>mail.notify(trx, kind, userId, params)<br>→ mail_deliveries row, pending … COMMIT
  code->>vk: enqueue on "mail", job id = delivery id
  Note over vk: If this enqueue is lost, the sweep re-enqueues<br>pending deliveries older than a minute, and the job id deduplicates.
  vk-->>w: job, when the global rate limit allows
  w->>pg: recipient (enabled, not erased, has email?), locale,<br>active template revision
  w->>w: kind.build() at send time → Liquid → Markdown → layout (HTML + text)
  w->>smtp: STARTTLS (or implicit TLS on 465), no SMTP auth
  alt accepted
    w->>pg: status sent
  else 4xx, connection or TLS error
    w->>vk: retry with backoff, up to 5 attempts
  else 5xx, or wording does not render
    w->>pg: status failed, log at error → alert
  end
```

## Campaign

```mermaid
sequenceDiagram
  autonumber
  actor admin as Admin (Mailings page)
  participant api
  participant pg as postgres (via pgbouncer)
  participant vk as valkey
  participant w as worker

  admin->>api: preview: recipient count, duration at the send limit,<br>rendering for the first recipient per locale
  admin->>api: confirm send
  api->>pg: one transaction: mail_campaigns row, pinned revision per locale,<br>audit mail.campaign.send
  api->>vk: enqueue on "maintenance"
  vk-->>w: campaign job
  w->>pg: kind.recipients() → one mail_deliveries row per user<br>(unique per campaign and user)
  w->>vk: one "mail" job per delivery
  Note over w: Each delivery then follows the outbox flow above.
```
