# Backup and restore

Illustrates [0017](../0017-nfs-backup-storage.md), with the Valkey snapshot from [0010](../0010-sessions-postgres-ratelimits-valkey.md) and the OpenBao snapshot from [0023](../0023-secrets-management.md). Where this page and an ADR or the code disagree, the ADR and the code win.

## What a run reads and writes

The `backup` service is on `db`, `object` and `secrets` only, so it has no route to the API, the worker or Valkey. It reads Valkey's snapshot from a read-only volume mount instead.

```mermaid
flowchart LR
  subgraph backupBox["backup container (UID 1100)"]
    sched(["cron from runtime settings,<br>re-read every 30 s"])
    restic["restic"]
    mirror[/"backup-data volume<br>uploads mirror"/]
  end

  postgres[("postgres :5432<br>databases app, netbox")]
  s3[("s3 :3900<br>bucket uploads")]
  openbao[("openbao :8200")]
  valkeyVol[/"valkey-data volume<br>dump.rdb (read-only mount)"/]
  target[/"/srv/backups<br>named volume locally,<br>NFS in CI and production"/]
  logs[/"logs volume<br>backup/*.log"/]

  sched --> restic
  restic -->|"db · pg_dump app, role backup<br>→ repository db"| postgres
  restic -->|"db · pg_dump netbox<br>→ repository netbox"| postgres
  mirror -->|"object · read-only key,<br>new objects only"| s3
  restic -->|"mirror → repository objects"| mirror
  restic -->|"secrets · raft snapshot<br>→ repository state"| openbao
  restic -->|"→ repository state"| valkeyVol
  restic -->|"encrypt, deduplicate,<br>forget --keep-daily 31 --prune"| target
  restic -->|"success line per run"| logs
  logs -. "alloy → loki → Grafana:<br>error line, or no success in 26 h" .-> alert(["alert mail"])
```

The `exports` bucket is never backed up: exports can be regenerated, and must not outlive their retention in a snapshot.

## One run

```mermaid
sequenceDiagram
  autonumber
  participant b as backup
  participant t as /srv/backups
  participant pg as postgres :5432
  participant s3 as s3 :3900
  participant bao as openbao :8200

  b->>t: all four repositories exist? probe file writable?
  alt missing, empty or read-only target
    b->>b: fail and log at error. Never init, never fall back to a local path.
  else
    b->>pg: db: restic backup --stdin-from-command pg_dump app
    b->>t: restic forget --keep-daily <retention> --prune
    b->>s3: objects: list uploads, fetch new objects, drop vanished ones from the mirror
    b->>t: restic backup mirror, then forget --prune
    b->>bao: state: raft snapshot (backup agent's token, snapshot policy only)
    b->>t: restic backup valkey.rdb + openbao.snap, then forget --prune
    b->>pg: netbox: restic backup --stdin-from-command pg_dump netbox
    b->>t: restic forget --prune
    Note over b: A repository that fails is logged at error<br>and the next one still runs.
    b->>b: log "backup completed" only when all four succeeded
  end
```

## Restore

Restores are a host procedure, `scripts/backup.sh`, run by an administrator: the backup service's own credentials stay read-only.

```mermaid
flowchart TD
  admin(["Administrator on the host"]) --> script["scripts/backup.sh"]
  script -->|"restore-db"| db["pg_restore as superuser<br>over postgres's socket"]
  script -->|"restore-netbox"| nb["pg_restore as the netbox login"]
  script -->|"restore-objects"| obj["backup service uploads with its own key;<br>write grant given for the restore only"]
  script -->|"restore-valkey"| vk["RDB becomes the base of a new AOF<br>in the stopped Valkey's volume"]
  script -->|"restore-openbao"| bao["raft snapshot restore -force,<br>then unseal with the backed-up key"]

  db --> post1["read the erasures log first<br>(from --erasures-from, the target, or app)"]
  post1 --> post2["revoke all sessions,<br>delete all API tokens"]
  post2 --> post3["re-apply every erasure<br>with its original time"]
```
