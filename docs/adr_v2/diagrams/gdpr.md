# GDPR export and erasure

Illustrates [0013](../0013-gdpr-export-and-retention.md), with the queue from [0024](../0024-background-jobs-bullmq.md), the notification from [0027](../0027-email-templates-and-sending.md) and the live update from [0012](../0012-role-scoped-channels.md). Where this page and an ADR or the code disagree, the ADR and the code win.

## Data subject export

```mermaid
sequenceDiagram
  autonumber
  actor b as Requester's browser
  participant api
  participant pg as postgres (via pgbouncer)
  participant vk as valkey (BullMQ)
  participant w as worker
  participant s3 as s3 :3900
  participant smtp as mail :1025

  b->>api: POST /api/data-exports {userId}
  api->>pg: one transaction: data_exports row (pending) + audit event<br>(409 if one is already pending for that person)
  api->>vk: enqueue job on "data-exports" (surrogate ids only)
  api-->>b: created, state pending

  vk-->>w: job (one at a time, 3 attempts)
  w->>pg: collect every store in the personal data registry
  w->>s3: read the person's files from "uploads"
  w->>s3: multipart upload of the ZIP into "exports"<br>export.json + files/<id>/<name>
  w->>pg: one transaction: state=ready, size, SHA-256,<br>mail_deliveries row for gdpr.export-ready (outbox)
  w->>vk: job completed
  vk-->>api: QueueEvents "completed"
  api-->>b: patched event on the requester's channel

  w->>smtp: export-ready mail (see the mail page)

  b->>api: GET /api/data-export-contents/<id> (requester only)
  api->>pg: audit the download
  api->>s3: GetObject from "exports"
  api-->>b: ZIP stream
```

The export expiry job deletes the object and then the row after the export retention (default 7 days); the `exports` bucket is never backed up.

## Erasure

```mermaid
sequenceDiagram
  autonumber
  actor admin as Admin's browser
  participant api
  participant pg as postgres (via pgbouncer)
  participant sockets as the person's sockets

  admin->>api: POST /api/erasures {userId}
  api->>api: refuse own account and break-glass (400), already erased (409)
  api->>pg: erase_user(id, now): clear TU-ID, names, email, avatar,<br>disable, delete sessions + refresh tokens + mail deliveries,<br>soft-delete files, delete documents, append to "erasures" log
  api->>pg: audit users.erase
  api->>sockets: close them (logged out everywhere)
  api-->>admin: done
  Note over pg: After a database restore, scripts/backup.sh restore-db<br>re-applies every entry of the "erasures" log.
```
