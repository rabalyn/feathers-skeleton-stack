#!/bin/bash
# Object storage container (ADR 0020): Garage on unix sockets, Nginx adding
# TLS in front, and on every start the buckets and each client's key and
# grants made to match the table below. Keys come from OpenBao through the
# s3-agent (ADR 0023); a key whose rendered id or secret changed is replaced,
# which is how a key is rotated.
#
# Healthy (compose healthcheck) once Garage answers and the bootstrap is done.
# If either process exits, the container exits.
set -euo pipefail

export RUST_LOG=${RUST_LOG:-warn}
# Garage wants secret files at 0600, owned by itself. The agent renders them
# 0440, owned by the agent, group garage, in a 0750 tmpfs only the agent and
# this container mount (ADR 0023): readable by nobody else, as intended.
export GARAGE_ALLOW_WORLD_READABLE_SECRETS=true
SECRETS=/run/secrets
READY=/run/garage/bootstrapped

# <client> <bucket> <read|write>, where write includes read. Each client has
# its own key: <client>_key_id and <client>_secret_key in /run/secrets. A
# client whose key is not delivered is skipped: `test` exists locally only.
GRANTS='
api     uploads  write
api     exports  write
worker  uploads  write
worker  exports  write
'
# Locally, the buckets of test runs, as <client>:<bucket>:<access> ...
# (compose.yaml); unset in production.
for grant in ${S3_LOCAL_GRANTS:-}; do
  GRANTS+="${grant//:/ }"$'\n'
done
BUCKETS=$(awk 'NF { print $2 }' <<<"$GRANTS" | sort -u | tr '\n' ' ')

log() { printf 's3: %s\n' "$*"; }

rm -f "$READY" /run/garage/*.sock
garage server --single-node &
garage_pid=$!
nginx -e stderr -c /etc/s3/nginx.conf -g 'daemon off;' &
nginx_pid=$!
trap 'kill -TERM "$garage_pid" "$nginx_pid" 2>/dev/null || true' TERM INT

api() { # <endpoint> ; JSON payload on stdin, never in argv
  garage json-api "$1" -
}

for _ in $(seq 60); do
  garage status >/dev/null 2>&1 && break
  sleep 1
done
garage status >/dev/null 2>&1 || { log "garage did not come up"; exit 1; }

for bucket in $BUCKETS; do
  if ! jq -n --arg b "$bucket" '{globalAlias: $b}' | api GetBucketInfo >/dev/null 2>&1; then
    jq -n --arg b "$bucket" '{globalAlias: $b}' | api CreateBucket >/dev/null
    log "created bucket $bucket"
  fi
done

ensure_key() { # <client>
  local name=$1 id secret current
  id=$(<"$SECRETS/${name}_key_id")
  secret=$(<"$SECRETS/${name}_secret_key")
  current=$(jq -n --arg n "$name" '{search: $n, showSecretKey: true}' | api GetKeyInfo 2>/dev/null || true)
  if [[ -n $current ]]; then
    if [[ $(jq -r .accessKeyId <<<"$current") == "$id" && $(jq -r .secretAccessKey <<<"$current") == "$secret" ]]; then
      return 0
    fi
    jq -n --arg id "$(jq -r .accessKeyId <<<"$current")" '{id: $id}' | api DeleteKey >/dev/null
    log "replaced the key of $name"
  fi
  jq -n --arg id "$id" --arg s "$secret" --arg n "$name" \
    '{accessKeyId: $id, secretAccessKey: $s, name: $n}' | api ImportKey >/dev/null
}

while read -r client bucket access; do
  [[ -z $client ]] && continue
  [[ -s $SECRETS/${client}_key_id && -s $SECRETS/${client}_secret_key ]] || continue
  ensure_key "$client"
  bucket_id=$(jq -n --arg b "$bucket" '{globalAlias: $b}' | api GetBucketInfo | jq -r .id)
  jq -n --arg b "$bucket_id" --arg k "$(<"$SECRETS/${client}_key_id")" --arg a "$access" \
    '{bucketId: $b, accessKeyId: $k, permissions: {read: true, write: ($a == "write"), owner: false}}' |
    api AllowBucketKey >/dev/null
done <<<"$GRANTS"

# The table is the whole truth: a grant it no longer lists is revoked.
for client in $(awk 'NF { print $1 }' <<<"$GRANTS" | sort -u); do
  [[ -s $SECRETS/${client}_key_id ]] || continue
  wanted=" $(awk -v c="$client" '$1 == c { printf "%s ", $2 }' <<<"$GRANTS")"
  key_id=$(<"$SECRETS/${client}_key_id")
  jq -n --arg id "$key_id" '{id: $id}' | api GetKeyInfo |
    jq -r '.buckets[] | [.id, (.globalAliases[0] // "")] | @tsv' |
    while IFS=$'\t' read -r bucket_id alias; do
      [[ $wanted == *" $alias "* ]] && continue
      jq -n --arg b "$bucket_id" --arg k "$key_id" \
        '{bucketId: $b, accessKeyId: $k, permissions: {read: true, write: true, owner: true}}' |
        api DenyBucketKey >/dev/null
      log "revoked $client on ${alias:-$bucket_id}"
    done
done

touch "$READY"
log "ready"

# Whichever exits first ends the container; the other is stopped with it.
rc=0
wait -n "$garage_pid" "$nginx_pid" || rc=$?
kill -TERM "$garage_pid" "$nginx_pid" 2>/dev/null || true
wait || true
exit "$rc"
