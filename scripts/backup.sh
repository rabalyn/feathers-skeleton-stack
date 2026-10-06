#!/usr/bin/env bash
# Backups and restores on the host (ADR 0017), for an administrator in
# production and for scripts/backup-test.sh, which runs every restore below
# in CI against throwaway targets.
#
#   scripts/backup.sh init        create the repositories on the target; once,
#                                 after mounting it (a run never creates one)
#   scripts/backup.sh run         one backup run now, besides the schedule
#   scripts/backup.sh snapshots   list every repository's snapshots
#
#   scripts/backup.sh restore-db <database> [--replace] [--snapshot <id>]
#                                [--erasures-from <database>]
#       pg_restore of the `db` snapshot into <database>, created fresh, as
#       the superuser over postgres's socket. --replace drops an existing
#       database first; refused while the api or the worker runs. Then the
#       mandatory post-steps: every session and API token revoked (ADR 0010,
#       0029), erasures re-applied (ADR 0013). The log of erasures is read,
#       before anything is dropped, from --erasures-from, else from
#       <database> itself when it exists, else from `app`; a copy is kept in
#       a file whose path is printed, for replay-erasures
#   scripts/backup.sh replay-erasures <database> --erasures-file <file>
#       re-apply a kept log of erasures to <database>; for a restored schema
#       too old to have erase_user(), once it is migrated
#   scripts/backup.sh restore-netbox <database> [--replace] [--snapshot <id>]
#       pg_restore of the `netbox` snapshot (ADR 0031) into <database>,
#       created fresh and owned by the `netbox` login. --replace drops an
#       existing database first; refused while netbox or netbox-worker runs.
#       netbox-setup's next start re-seeds and re-issues the api's token
#   scripts/backup.sh restore-objects <bucket> [--snapshot <id>] [--empty]
#       upload the `objects` snapshot into <bucket> with the backup key,
#       which gets write access to <bucket> for the duration only. --empty
#       removes what the bucket holds first; refused for production buckets
#   scripts/backup.sh restore-valkey <volume> [--snapshot <id>]
#       put the snapshot's RDB file into Valkey's <volume>, dropping its AOF
#       so the RDB is what loads; refused while a container uses <volume>
#   scripts/backup.sh restore-openbao <container> [--snapshot <id>]
#       restore the raft snapshot into the OpenBao in <container>, with a
#       root token read from stdin (production: `bao operator generate-root`
#       with the unseal key). It then needs the unseal key of the backed-up
#       OpenBao: `scripts/openbao.sh unseal` in production
#
# Every restore reads from the backup container, as its own user. BACKUP_ENV
# (KEY=value ...) overrides that container's configuration for this call:
# the test points it at a database, a bucket and repositories of its own.
#
# The containers are named as in production, `backup`, `postgres` and `s3`.
# A local stack prefixes its containers with the project name (ADR 0035);
# there, CONTAINER_PREFIX=<project>- names them.
set -euo pipefail

BACKUP=${BACKUP_CONTAINER:-${CONTAINER_PREFIX:-}backup}
POSTGRES=${POSTGRES_CONTAINER:-${CONTAINER_PREFIX:-}postgres}
S3=${S3_CONTAINER:-${CONTAINER_PREFIX:-}s3}
HELPER_IMAGE=docker.io/library/alpine:3.24.2@sha256:d56c381f961d307a21b3ca004cf1e3910f106644aefb1f43e654c8a56c4fd395

log() { printf '\033[1mbackup:\033[0m %s %s\n' "$(date +%T)" "$*" >&2; }
die() { log "$*"; exit 1; }
running() { [[ $(podman container inspect -f '{{.State.Running}}' "$1" 2>/dev/null) == true ]]; }

backup_env=()
for kv in ${BACKUP_ENV:-}; do backup_env+=(-e "$kv"); done
in_backup() { podman exec -i -u backup "${backup_env[@]}" "$BACKUP" node dist/backup.js "$@"; }

psql_super() { # <database> [psql options] ; SQL on stdin
  podman exec -i -u postgres "$POSTGRES" psql -q -v ON_ERROR_STOP=1 -X -d "$1" "${@:2}"
}

snapshot=latest
replace=false
empty=
erasures_from=
erasures_file=
parse_options() {
  while (($#)); do
    case $1 in
      --snapshot) snapshot=${2:?--snapshot needs an id}; shift ;;
      --erasures-from) erasures_from=${2:?--erasures-from needs a database}; shift ;;
      --erasures-file) erasures_file=${2:?--erasures-file needs a file}; shift ;;
      --replace) replace=true ;;
      --empty) empty=--empty ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
}

valid_name() { [[ $1 =~ ^[a-z_][a-z0-9_]*$ ]] || die "not a database name: $1"; }

db_exists() { [[ -n $(psql_super postgres -tA <<<"SELECT 1 FROM pg_database WHERE datname = '$1'") ]]; }

# The erasure log of a live database (ADR 0013): "<surrogate id>|<erased at>"
# per line. It lives in the database it protects, so it is read before a
# restore replaces that database; one without the table has erased nobody.
read_erasures() { # <database>
  psql_super "$1" -tA <<'SQL'
SELECT CASE WHEN to_regclass('public.erasures') IS NULL THEN ''
  ELSE (SELECT coalesce(string_agg(user_id || '|' || erased_at, E'\n' ORDER BY erased_at), '') FROM erasures) END
SQL
}

restore_db() { # <database>
  local db=$1 source=
  valid_name "$db"
  running "$POSTGRES" || die "$POSTGRES is not running"
  if [[ -n $erasures_from ]]; then
    valid_name "$erasures_from"
    db_exists "$erasures_from" || die "no database $erasures_from to read erasures from"
    source=$erasures_from
  elif db_exists "$db"; then
    source=$db
  elif db_exists app; then
    source=app
  fi
  erasures_file=$(mktemp "${TMPDIR:-/tmp}/erasures-$db.XXXXXX")
  if [[ -n $source ]]; then
    read_erasures "$source" >"$erasures_file"
    log "read $(grep -c . "$erasures_file" || true) erasures from $source into $erasures_file"
  else
    log "WARNING: no live database to read erasures from; erasures after the backup cannot be re-applied"
  fi
  if db_exists "$db"; then
    [[ $replace == true ]] || die "database $db exists; --replace drops it first"
    if running api || running worker; then die "stop the api and the worker before replacing $db"; fi
  fi
  # Created as roles.sh creates `app`: owned by migrator, reachable by the
  # application roles and read by the backup role.
  psql_super postgres <<SQL
DROP DATABASE IF EXISTS $db WITH (FORCE);
CREATE DATABASE $db OWNER migrator;
REVOKE ALL ON DATABASE $db FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $db TO app_rw;
GRANT CONNECT ON DATABASE $db TO backup;
SQL
  log "restoring the database snapshot $snapshot into $db"
  in_backup dump db app.dump "$snapshot" |
    podman exec -i -u postgres "$POSTGRES" pg_restore --dbname="$db" --exit-on-error --single-transaction
  post_restore "$db"
}

# NetBox's database (ADR 0031): no post-steps of its own. Its sessions are
# NetBox's, and the api's token is re-issued from OpenBao by netbox-setup.
restore_netbox() { # <database>
  local db=$1
  valid_name "$db"
  running "$POSTGRES" || die "$POSTGRES is not running"
  if db_exists "$db"; then
    [[ $replace == true ]] || die "database $db exists; --replace drops it first"
    if running netbox || running netbox-worker; then die "stop netbox and netbox-worker before replacing $db"; fi
  fi
  # Created as roles.sh creates `netbox`.
  psql_super postgres <<SQL
DROP DATABASE IF EXISTS $db WITH (FORCE);
CREATE DATABASE $db OWNER netbox;
REVOKE ALL ON DATABASE $db FROM PUBLIC;
GRANT CONNECT ON DATABASE $db TO backup;
SQL
  log "restoring the NetBox snapshot $snapshot into $db"
  # As its owner, so the restored objects are NetBox's.
  in_backup dump netbox netbox.dump "$snapshot" |
    podman exec -i -u postgres "$POSTGRES" pg_restore --dbname="$db" --role=netbox --no-owner --exit-on-error --single-transaction
}

# Mandatory after every database restore (ADR 0017).
post_restore() { # <database>
  local revoked
  revoked=$(psql_super "$1" -tA <<<"WITH r AS (UPDATE auth_sessions SET revoked_at = now() WHERE revoked_at IS NULL RETURNING 1) SELECT count(*) FROM r")
  log "revoked every session in $1 ($revoked were live at the backup)"
  # API tokens revoked after the backup would be live again (ADR 0029); a
  # snapshot older than the table has none.
  revoked=$(psql_super "$1" -tA <<<"SELECT CASE WHEN to_regclass('public.api_tokens') IS NULL THEN 0 ELSE (SELECT count(*) FROM api_tokens) END")
  if [[ $revoked != 0 ]]; then psql_super "$1" <<<"DELETE FROM api_tokens"; fi
  log "revoked every API token in $1 ($revoked existed at the backup)"
  replay_erasures "$1"
}

# Erases again everyone the log names, with the time they were erased at;
# erase_user() is idempotent and ignores ids the database does not have
# (ADR 0013).
replay_erasures() { # <database>
  local db=$1 applied
  valid_name "$db"
  [[ -n $erasures_file && -r $erasures_file ]] || die "no erasure log to replay: --erasures-file <file>"
  if ! grep -q . "$erasures_file"; then
    log "erasures: the log is empty, nothing to re-apply"
    return 0
  fi
  if [[ -z $(psql_super "$db" -tA <<<"SELECT to_regprocedure('erase_user(uuid, timestamptz)')") ]]; then
    die "$db predates erasure (ADR 0013): migrate it, then run: $0 replay-erasures $db --erasures-file $erasures_file"
  fi
  applied=$(
    { printf 'CREATE TEMP TABLE replay (user_id uuid, erased_at timestamptz);\nCOPY replay FROM STDIN (DELIMITER %s);\n' "'|'"
      grep . "$erasures_file"
      printf '\\.\nSELECT count(*) FILTER (WHERE erase_user(user_id, erased_at)) FROM replay;\n'
    } | psql_super "$db" -tA
  )
  log "erasures: re-applied $(grep -c . "$erasures_file") from the log, $applied of them to accounts in $db"
}

# Gives the backup key write access to a bucket, or takes it back; its read
# access is the s3 container's grant table's business.
bucket_write() { # <allow|deny> <bucket>
  podman exec -i "$S3" bash -s "$1" "$2" <<'SH'
set -euo pipefail
key=$(</run/secrets/backup_key_id)
id=$(jq -n --arg b "$2" '{globalAlias: $b}' | garage json-api GetBucketInfo - | jq -r .id)
if [[ $1 == allow ]]; then
  endpoint=AllowBucketKey permissions='{read: true, write: true, owner: false}'
else
  endpoint=DenyBucketKey permissions='{read: false, write: true, owner: false}'
fi
jq -n --arg b "$id" --arg k "$key" "{bucketId: \$b, accessKeyId: \$k, permissions: $permissions}" |
  garage json-api "$endpoint" - >/dev/null
SH
}

restore_objects() { # <bucket>
  local bucket=$1
  [[ $bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "not a bucket name: $bucket"
  bucket_write allow "$bucket"
  # shellcheck disable=SC2064
  trap "bucket_write deny '$bucket'" EXIT
  log "restoring the objects snapshot $snapshot into $bucket"
  in_backup restore-objects --bucket "$bucket" --snapshot "$snapshot" $empty
  bucket_write deny "$bucket"
  trap - EXIT
}

restore_valkey() { # <volume>
  local volume=$1
  podman volume exists "$volume" || die "no volume $volume"
  [[ -z $(podman ps -q --filter "volume=$volume") ]] || die "stop the container using $volume first"
  log "restoring the Valkey snapshot $snapshot into $volume"
  # With appendonly on, Valkey loads only its AOF, and starts empty when it
  # has none, whatever RDB lies next to it. So the RDB becomes the base of a
  # new AOF, the form Valkey itself writes (a base in RDB format, listed in
  # the manifest), and stays as dump.rdb for a Valkey without AOF. Its entry
  # point takes ownership of the files.
  in_backup dump state valkey.rdb "$snapshot" |
    podman run --rm -i --network none -v "$volume:/data" "$HELPER_IMAGE" sh -c '
      set -e
      cat > /data/.restore.rdb
      rm -rf /data/appendonlydir
      mkdir /data/appendonlydir
      cp /data/.restore.rdb /data/appendonlydir/appendonly.aof.1.base.rdb
      printf "file appendonly.aof.1.base.rdb seq 1 type b\n" > /data/appendonlydir/appendonly.aof.manifest
      mv /data/.restore.rdb /data/dump.rdb'
}

restore_openbao() { # <container> ; root token on stdin
  local container=$1 token
  running "$container" || die "$container is not running"
  IFS= read -r token || die "a root token is expected on stdin"
  log "restoring the OpenBao snapshot $snapshot into $container"
  in_backup dump state openbao.snap "$snapshot" | podman exec -i "$container" sh -c 'umask 077; cat > /tmp/restore.snap'
  printf '%s\n' "$token" | podman exec -i "$container" sh -c '
    IFS= read -r BAO_TOKEN; export BAO_TOKEN
    rc=0; bao operator raft snapshot restore -force /tmp/restore.snap || rc=$?
    rm -f /tmp/restore.snap; exit $rc'
  log "restored; unseal $container with the unseal key of the backed-up OpenBao"
}

cmd=${1:-}
case $cmd in
  init | run | snapshots) in_backup "$cmd" ;;
  restore-db | restore-netbox | restore-objects | restore-valkey | restore-openbao | replay-erasures)
    target=${2:-}
    [[ -n $target && $target != --* ]] || die "usage: $0 $cmd <target> [options]"
    shift 2
    parse_options "$@"
    "${cmd//-/_}" "$target"
    ;;
  *) sed -n '2,44p' "$0"; exit 2 ;;
esac
