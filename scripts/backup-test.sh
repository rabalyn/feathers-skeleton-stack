#!/usr/bin/env bash
# The backup-and-restore check (ADR 0017), part of scripts/ci.sh: the
# backup service's own run, a target that is missing, empty or read-only,
# then a full cycle through scripts/backup.sh into clean targets, verified.
#
# The cycle backs up a source of its own, `backup_check` and the bucket
# `backup-check`, into repositories of its own under the real target
# (/srv/backups/check: the NFS export in CI), so the local app's data is
# only ever read. NetBox's database (ADR 0031) is the stack's own, read
# likewise and restored into `restore_netbox_check`. Valkey and OpenBao are the stack's own, restored into a
# throwaway Valkey and a throwaway OpenBao. Everything the check creates is
# removed at the end.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/product.sh
source "$ROOT/scripts/product.sh"
# backup.sh reaches the local stack's containers by their prefixed names.
export CONTAINER_PREFIX
BACKUP_SH=$ROOT/scripts/backup.sh
P=backup-test
SOURCE_DB=backup_check
SOURCE_BUCKET=backup-check
RESTORE_DB=restore_check
RESTORE_BUCKET=restore-check
RESTORE_NETBOX=restore_netbox_check
CHECK_DIR=/srv/backups/check
# The check's own runs log to stdout only: their failures on purpose must
# not raise the backup alert, nor their successes stand in for the service's
# (ADR 0022).
CHECK_ENV="LOG_FILE= DATABASE_NAME=$SOURCE_DB S3_UPLOADS_BUCKET=$SOURCE_BUCKET BACKUP_TARGET_DIR=$CHECK_DIR"
OPENBAO_IMAGE=$(sed -n 's/^ *image: \(docker.io\/openbao\/openbao@sha256:[0-9a-f]*\).*/\1/p' "$ROOT/compose.yaml" | head -1)
VALKEY_IMAGE=$(sed -n 's/^ *image: \(docker.io\/valkey\/valkey@sha256:[0-9a-f]*\).*/\1/p' "$ROOT/compose.yaml" | head -1)
HELPER_IMAGE=docker.io/library/alpine:3.24.2@sha256:d56c381f961d307a21b3ca004cf1e3910f106644aefb1f43e654c8a56c4fd395
UNSEAL_VOLUME=$PRODUCT-openbao-local-unseal

failures=0
# Output is shown only for a failing check.
check() { # <description> <command...>
  local out
  if out=$("${@:2}" 2>&1); then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n' "$1"
    [[ -z $out ]] || sed 's/^/        /' <<<"$out"
    failures=$((failures + 1))
  fi
}
fails() { ! "$@" >/dev/null 2>&1; }
log() { printf 'backup-test: %s\n' "$*"; }
die() { printf 'backup-test: %s\n' "$*" >&2; exit 1; }

running() { [[ $(podman container inspect -f '{{.State.Running}}' "$1" 2>/dev/null) == true ]]; }
psql_super() { podman exec -i -u postgres "$(ctr postgres)" psql -q -tA -v ON_ERROR_STOP=1 -X -d "$1"; }
in_backup() { podman exec -i -u backup "$(ctr "$1")" "${@:2}"; }
backup_sh() { BACKUP_ENV=$CHECK_ENV "$BACKUP_SH" "$@"; }

# Runs a Node module in the backup container, with the S3 client configured
# for <bucket> and the backup key.
node_s3() { # <bucket> ; module on stdin
  podman exec -i -u backup -e "S3_UPLOADS_BUCKET=$1" -w /repo/apps/api "$(ctr backup)" node --input-type=module
}
S3_PRELUDE="import { loadConfig, S3_KEYS } from '/repo/apps/api/dist/config.js'
import { Storage } from '/repo/apps/api/dist/storage.js'
const storage = new Storage(await loadConfig(S3_KEYS))"

bucket_write() { # <allow|deny> <bucket>: what backup.sh does around a restore
  podman exec -i "$(ctr s3)" bash -s "$1" "$2" <<'SH'
set -euo pipefail
key=$(</run/secrets/backup_key_id)
id=$(jq -n --arg b "$2" '{globalAlias: $b}' | garage json-api GetBucketInfo - | jq -r .id)
[[ $1 == allow ]] && ep=AllowBucketKey p=true || ep=DenyBucketKey p=true
jq -n --arg b "$id" --arg k "$key" --argjson w "$p" '{bucketId: $b, accessKeyId: $k, permissions: {read: false, write: $w, owner: false}}' |
  garage json-api "$ep" - >/dev/null
SH
}

empty_bucket() { # <bucket>
  bucket_write allow "$1"
  node_s3 "$1" <<<"$S3_PRELUDE
await storage.empty(); storage.close()" || true
  bucket_write deny "$1"
}

cleanup() {
  podman rm -f "$P-valkey" "$P-openbao" "$P-backup-ro" >/dev/null 2>&1 || true
  podman volume rm -f "$P-valkey" >/dev/null 2>&1 || true
  if running "$(ctr backup)"; then
    in_backup backup rm -rf "$CHECK_DIR" /srv/backups/check-empty "/var/lib/backup/mirror/$SOURCE_BUCKET" >/dev/null 2>&1 || true
    running "$(ctr s3)" && { empty_bucket "$SOURCE_BUCKET"; empty_bucket "$RESTORE_BUCKET"; } >/dev/null 2>&1
  fi
  if running "$(ctr postgres)"; then
    psql_super postgres <<<"DROP DATABASE IF EXISTS $SOURCE_DB WITH (FORCE); DROP DATABASE IF EXISTS $RESTORE_DB WITH (FORCE);
      DROP DATABASE IF EXISTS $RESTORE_NETBOX WITH (FORCE);" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for c in backup postgres s3 valkey openbao netbox; do running "$(ctr "$c")" || die "$(ctr "$c") is not running; run scripts/stack.sh up"; done
[[ -n $OPENBAO_IMAGE && -n $VALKEY_IMAGE ]] || die "images not found in compose.yaml"
cleanup

# Valkey writes its RDB snapshot on its save points; a fresh stack may have
# none yet, or one from before the backup user could read it. A restart
# writes it (Valkey saves on shutdown).
if ! in_backup backup test -r /var/lib/valkey/dump.rdb; then
  log "restarting Valkey for a readable snapshot"
  podman restart "$(ctr valkey)" >/dev/null
  for _ in $(seq 30); do podman healthcheck run "$(ctr valkey)" >/dev/null 2>&1 && break; sleep 1; done
fi

# --- the service's own run -------------------------------------------------

log "the service's own run"
log_file() { in_backup backup sh -c 'cat /var/log/app/backup/*.log'; }
before=$(log_file | grep -c '"backup completed"' || true)
check "a run over the app's database and bucket succeeds" "$BACKUP_SH" run
after=$(log_file | grep -c '"backup completed"' || true)
check "... and writes its success line to the log file" test "$after" -gt "$before"
has_snapshot() { in_backup backup restic -r "/srv/backups/$1" --cache-dir /var/lib/backup/cache snapshots --json latest | jq -e 'length == 1' >/dev/null; }
check "every repository has a snapshot" bash -c "$(declare -f ctr in_backup has_snapshot); has_snapshot db && has_snapshot objects && has_snapshot state && has_snapshot netbox"

# --- the target ------------------------------------------------------------

log "the target"
out=$(BACKUP_ENV="LOG_FILE= BACKUP_TARGET_DIR=/srv/backups/nowhere" "$BACKUP_SH" run 2>&1 || true)
check "a missing target fails the run" grep -q 'holds no repository' <<<"$out"
in_backup backup mkdir -p /srv/backups/check-empty
out=$(BACKUP_ENV="LOG_FILE= BACKUP_TARGET_DIR=/srv/backups/check-empty" "$BACKUP_SH" run 2>&1 || true)
check "an empty target (an unmounted export) fails the run" grep -q 'holds no repository' <<<"$out"
check "... and nothing is written to it" test -z "$(in_backup backup ls -A /srv/backups/check-empty)"

# The same container, with its target mounted read-only.
target_source=$(podman inspect "$(ctr backup)" --format '{{range .Mounts}}{{if eq .Destination "/srv/backups"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}')
env_file=$(mktemp)
podman inspect "$(ctr backup)" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^LOG_FILE=' >"$env_file"
out=$(podman run --rm --name "$P-backup-ro" --user 1100:1100 --network "${PRODUCT}_db" --env-file "$env_file" -e LOG_FILE= \
  -v "$target_source:/srv/backups:ro" -v "${PRODUCT}_backup-data:/var/lib/backup" -v "${PRODUCT}_backup-secrets:/run/secrets:ro" \
  -v "${PRODUCT}_trust:/trust:ro" --entrypoint node "localhost/$PRODUCT-backup:dev" dist/backup.js run 2>&1 || true)
rm -f "$env_file"
check "a read-only target fails the run" grep -q 'is not writable' <<<"$out"

# --- a source of its own ---------------------------------------------------

log "seeding $SOURCE_DB and $SOURCE_BUCKET"
psql_super postgres <<SQL >/dev/null
CREATE DATABASE $SOURCE_DB OWNER migrator;
REVOKE ALL ON DATABASE $SOURCE_DB FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $SOURCE_DB TO app_rw;
GRANT CONNECT ON DATABASE $SOURCE_DB TO backup;
SQL
(cd "$ROOT" && podman-compose --profile local run --rm -T -e DATABASE_NAME=$SOURCE_DB migrate >/dev/null 2>&1) ||
  die "migrating $SOURCE_DB failed"

bucket_write allow "$SOURCE_BUCKET"
objects=$(node_s3 "$SOURCE_BUCKET" <<JS
$S3_PRELUDE
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
for (const size of [1, 70000, 300000]) {
  const id = randomUUID(), bytes = randomBytes(size)
  await storage.put(id, Readable.from(bytes), size, 'application/octet-stream')
  console.log(id, createHash('sha256').update(bytes).digest('hex'), size)
}
storage.close()
JS
)
bucket_write deny "$SOURCE_BUCKET"
read -r f1 s1 z1 f2 s2 z2 f3 s3 z3 <<<"$(tr '\n' ' ' <<<"$objects")"
[[ -n ${z3:-} ]] || die "seeding objects failed"
psql_super "$SOURCE_DB" <<SQL >/dev/null
INSERT INTO users (id, tu_id, given_name, surname, enabled, auth_source, avatar_file_id) VALUES
  ('00000000-0000-7000-8000-000000000001', 'bk01chck', 'Bea', 'Backup', true, 'saml', NULL),
  ('00000000-0000-7000-8000-000000000002', 'bk02chck', 'Rolf', 'Restore', true, 'saml', NULL),
  -- Erased after the backup: the restore must erase them again.
  ('00000000-0000-7000-8000-000000000003', 'bk03chck', 'Erik', 'Erased', true, 'saml', NULL);
INSERT INTO user_roles (user_id, role_id)
  SELECT u.id::uuid, roles.id FROM (VALUES
    ('00000000-0000-7000-8000-000000000001', 'user'),
    ('00000000-0000-7000-8000-000000000002', 'admin'),
    ('00000000-0000-7000-8000-000000000003', 'user')
  ) AS u (id, role_key) JOIN roles ON roles.key = u.role_key;
INSERT INTO files (id, owner_id, filename, content_type, size_bytes, sha256, state, attached_at, deleted_at) VALUES
  ('$f1', '00000000-0000-7000-8000-000000000001', 'a.pdf', 'application/pdf', $z1, '$s1', 'stored', now(), NULL),
  ('$f2', '00000000-0000-7000-8000-000000000001', 'b.png', 'image/png', $z2, '$s2', 'stored', now(), NULL),
  -- Soft-deleted, not yet purged: its object must come back too.
  ('$f3', '00000000-0000-7000-8000-000000000002', 'c.pdf', 'application/pdf', $z3, '$s3', 'stored', now(), now());
INSERT INTO documents (owner_id, title, file_id) VALUES ('00000000-0000-7000-8000-000000000001', 'Before the backup', '$f1');
UPDATE users SET avatar_file_id = '$f2' WHERE id = '00000000-0000-7000-8000-000000000001';
INSERT INTO auth_sessions (user_id, idle_expires_at, family_expires_at)
  VALUES ('00000000-0000-7000-8000-000000000002', now() + interval '1 hour', now() + interval '1 day');
INSERT INTO api_tokens (user_id, name, token_hash, hint, permissions)
  VALUES ('00000000-0000-7000-8000-000000000002', 'script', repeat('0', 64), 'abcd', '{users.read}');
SQL

# --- backup ----------------------------------------------------------------

log "backing up the source into $CHECK_DIR"
in_backup backup mkdir -p "$CHECK_DIR"
check "init creates the repositories" backup_sh init
check "init is idempotent" backup_sh init
check "the run succeeds" backup_sh run

# Changes after the backup, which a restore must not bring back; and an
# erasure after the backup, which it must re-apply (ADR 0013).
psql_super "$SOURCE_DB" <<SQL >/dev/null
INSERT INTO documents (owner_id, title, file_id) VALUES ('00000000-0000-7000-8000-000000000002', 'After the backup', '$f3');
SELECT erase_user('00000000-0000-7000-8000-000000000003');
SQL

# --- restore: database -----------------------------------------------------

log "restoring into $RESTORE_DB"
check "restore-db into a clean database" backup_sh restore-db "$RESTORE_DB" --erasures-from "$SOURCE_DB"
check "restore-db refuses an existing database without --replace" fails backup_sh restore-db "$RESTORE_DB"
q() { psql_super "$RESTORE_DB" <<<"$1"; }
check "the rows of the backup are there" test "$(q 'SELECT count(*) FROM users')/$(q 'SELECT count(*) FROM files')" = 3/3
check "the avatar reference survived" test "$(q "SELECT avatar_file_id FROM users WHERE tu_id = 'bk01chck'")" = "$f2"
check "a change after the backup is not" test "$(q "SELECT string_agg(title, ',') FROM documents")" = "Before the backup"
check "the runtime settings came with it" test "$(q 'SELECT count(*) FROM settings')" = "$(psql_super "$SOURCE_DB" <<<'SELECT count(*) FROM settings')"
check "the schema is at the same migration" test "$(q 'SELECT max(name) FROM knex_migrations')" = "$(psql_super "$SOURCE_DB" <<<'SELECT max(name) FROM knex_migrations')"
check "post-step: every session is revoked" test "$(q 'SELECT count(*) FROM auth_sessions WHERE revoked_at IS NULL')" = 0
check "post-step: every API token is revoked" test "$(q 'SELECT count(*) FROM api_tokens')" = 0
check "post-step: the erasure after the backup is re-applied" \
  test "$(q "SELECT coalesce(tu_id, '-') || enabled FROM users WHERE id = '00000000-0000-7000-8000-000000000003'")" = -false
check "... and logged in the restored database, with its time" \
  test "$(q "SELECT erased_at FROM erasures")" = "$(psql_super "$SOURCE_DB" <<<'SELECT erased_at FROM erasures')"
check "... and nobody else is erased" test "$(q 'SELECT count(*) FROM users WHERE erased_at IS NULL')" = 2
check "the application role may use the restored tables" \
  test "$(q "SELECT has_table_privilege('app', 'files', 'SELECT,INSERT,UPDATE,DELETE')")" = t

# --- restore: objects ------------------------------------------------------

log "restoring into $RESTORE_BUCKET"
check "restore-objects into a clean bucket" backup_sh restore-objects "$RESTORE_BUCKET" --empty
check "--empty is refused for a production bucket" fails backup_sh restore-objects uploads --empty
check "the backup key has no write access left" fails node_s3 "$RESTORE_BUCKET" <<<"$S3_PRELUDE
import { Readable } from 'node:stream'
await storage.put('write-probe', Readable.from(Buffer.from('x')), 1, 'text/plain')"
# Every object the restored database references exists, with its checksum.
references=$(q "SELECT id || ' ' || sha256 FROM files ORDER BY id")
unresolved=$(node_s3 "$RESTORE_BUCKET" <<JS
$S3_PRELUDE
import { createHash } from 'node:crypto'
let bad = 0
for (const line of \`$references\`.trim().split('\n')) {
  const [id, sha] = line.split(' ')
  const object = await storage.get(id)
  if (!object) { bad++; continue }
  const hash = createHash('sha256')
  for await (const chunk of object.body) hash.update(chunk)
  if (hash.digest('hex') !== sha) bad++
}
storage.close()
console.log(bad)
JS
)
check "every file row resolves to its object, byte for byte" test "$unresolved" = 0
check "... for all of them" test "$(wc -l <<<"$references")" = 3

# --- restore: NetBox -------------------------------------------------------

log "restoring NetBox into $RESTORE_NETBOX"
check "restore-netbox into a clean database" backup_sh restore-netbox "$RESTORE_NETBOX"
check "restore-netbox refuses an existing database without --replace" fails backup_sh restore-netbox "$RESTORE_NETBOX"
nq() { psql_super "$1" <<<"$2"; }
check "NetBox's sites are there, with their ids" \
  test "$(nq "$RESTORE_NETBOX" "SELECT string_agg(id || facility, ',' ORDER BY id) FROM dcim_site")" = \
  "$(nq netbox "SELECT string_agg(id || facility, ',' ORDER BY id) FROM dcim_site")"
check "the restored tables belong to NetBox's login" \
  test "$(nq "$RESTORE_NETBOX" "SELECT tableowner FROM pg_tables WHERE tablename = 'dcim_site'")" = netbox

# --- restore: Valkey -------------------------------------------------------

log "restoring Valkey into a throwaway one"
podman volume create "$P-valkey" >/dev/null
check "restore-valkey into a clean volume" backup_sh restore-valkey "$P-valkey"
podman run -d --name "$P-valkey" --network none -v "$P-valkey:/data" "$VALKEY_IMAGE" \
  valkey-server --appendonly yes --dir /data >/dev/null
for _ in $(seq 30); do podman exec "$P-valkey" valkey-cli ping 2>/dev/null | grep -q PONG && break; sleep 1; done
check "Valkey loads it, with AOF on" test "$(podman exec "$P-valkey" valkey-cli config get appendonly | tail -1)" = yes
check "the worker's job schedulers are in it" test -n "$(podman exec "$P-valkey" valkey-cli --scan --pattern 'bull:maintenance:*' | head -1)"
check "restore-valkey refuses a volume in use" fails backup_sh restore-valkey "$P-valkey"

# --- restore: OpenBao ------------------------------------------------------

log "restoring OpenBao into a throwaway one"
config='storage "raft" {
  path    = "/openbao/data"
  node_id = "openbao"
}
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"'
# The stack's snapshot carries its audit device, a file on the log volume
# (ADR 0023): OpenBao becomes active only once it can open it, and then
# drops it, since this configuration declares none.
podman run -d --name "$P-openbao" --network none -e BAO_ADDR=http://127.0.0.1:8200 \
  --tmpfs /var/log/app:rw,mode=1777 --entrypoint sh "$OPENBAO_IMAGE" \
  -c "mkdir -p /openbao/data /var/log/app/openbao && printf '%s' '$config' > /tmp/server.hcl && exec bao server -config=/tmp/server.hcl" >/dev/null
bao_status() { podman exec "$P-openbao" bao status -format=json 2>/dev/null | jq -r ".$1"; }
for _ in $(seq 30); do [[ -n $(bao_status initialized) ]] && break; sleep 1; done
init=$(podman exec "$P-openbao" bao operator init -key-shares=1 -key-threshold=1 -format=json)
unseal() { podman exec -i "$P-openbao" bao write -format=json sys/unseal key=- >/dev/null 2>&1; }
jq -r '.unseal_keys_b64[0]' <<<"$init" | unseal
jq -r .root_token <<<"$init" | backup_sh restore-openbao "$P-openbao" >/dev/null 2>&1
check "restore-openbao leaves it sealed, with the backed-up keys" test "$(bao_status sealed)" = true
unseal_read() { podman run --rm --network none -v "$UNSEAL_VOLUME:/u:ro" "$HELPER_IMAGE" cat "/u/$1"; }
unseal_read unseal_key | unseal || true
check "the stack's unseal key opens it" test "$(bao_status sealed)" = false
live=$(podman exec -u backup "$(ctr backup)" sh -c "tr -d '\\n' < /run/secrets/restic_password | sha256sum")
restored=$(unseal_read admin_token | podman exec -i "$P-openbao" sh -c \
  'IFS= read -r BAO_TOKEN; export BAO_TOKEN; bao kv get -field=restic_password kv/backup | tr -d "\\n" | sha256sum')
check "its secrets are the stack's (the restic password, compared by hash)" test "$live" = "$restored"

((failures == 0)) || die "$failures failed"
log "all passed"
