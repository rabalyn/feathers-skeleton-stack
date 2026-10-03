# File uploads and downloads

Illustrates [0020](../0020-object-storage-uploads.md), with authorization from [0011](../0011-casl-role-authorization.md). Where this page and an ADR or the code disagree, the ADR and the code win.

The browser never reaches the object store: `s3` is on `object` only, which Nginx is not on. Every byte goes through the API.

## Upload and attach

```mermaid
sequenceDiagram
  autonumber
  actor b as Browser
  participant ngx as nginx
  participant api
  participant pg as postgres (via pgbouncer)
  participant s3 as s3 :3900 (bucket uploads)

  b->>ngx: POST /api/files<br>raw body, Content-Type, Content-Length,<br>X-File-Name (percent-encoded)
  Note over ngx: body above the deployment ceiling → 413
  ngx->>api: streamed
  api->>api: type on the allowlist? else 415<br>Content-Length present? else 411<br>size ≤ maximum? else 413<br>magic bytes match the type? else 415
  api->>pg: lock, check per-user and total quota (else 413),<br>insert files row state=pending, key = new UUID
  api->>s3: PutObject key=UUID, streamed, hashed and counted
  alt body shorter or longer than declared, or any failure
    api->>s3: remove the partial object
    api->>pg: delete the row
    api-->>b: error
  else
    api->>pg: state=stored, size, SHA-256
    api-->>b: file metadata {id, …}
  end

  b->>api: documents.create({title, fileId}) or avatars.create({fileId})
  api->>pg: one transaction: file is stored, unattached, the caller's own,<br>of an allowed type → attach, and a replaced file is soft-deleted
  api-->>b: created
```

## Download

```mermaid
sequenceDiagram
  autonumber
  actor b as Browser
  participant api
  participant pg as postgres (via pgbouncer)
  participant s3 as s3 :3900

  b->>api: GET /api/file-contents/<id><br>Authorization: Bearer access token
  api->>pg: files row + the record attaching it
  api->>api: owner, or the caller's rule on the attaching record<br>(in view-as: the intersected rule)
  alt not allowed, or no such file
    api-->>b: 404, worded the same for both
  else
    api->>s3: GetObject key=id
    s3-->>api: stream
    api-->>b: stream, verified Content-Type, nosniff,<br>CSP default-src 'none'#59; sandbox, no-store,<br>attachment (documents) or inline avatar.png|jpg|webp
  end
  Note over b: The SPA turns the bytes into a blob URL,<br>since the access token lives in memory only.
```

## Lifecycle of an object

Objects are written once and never modified; deletion is soft and the worker purges later. That is what lets the database and the bucket be backed up independently ([0017](../0017-nfs-backup-storage.md)).

```mermaid
stateDiagram-v2
  [*] --> pending: POST /api/files reserves quota
  pending --> stored: bytes complete
  pending --> [*]: failure, or pending > 1 h (object purge job)
  stored --> attached: document / avatar points at it
  stored --> softDeleted: unattached after 24 h (object purge job)
  attached --> softDeleted: replaced, record deleted, or owner erased
  softDeleted --> [*]: purge delay passed (default 32 days > backup retention)<br>object first, then row
```

The same daily purge also removes objects older than a day that no row describes. A row is always written before its object, so only a failure or a restore to an earlier database state leaves such objects, and nothing can reference them.
