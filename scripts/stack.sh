#!/usr/bin/env bash
# Local and CI stack control (ADR 0001, 0023).
#
#   scripts/stack.sh up      build, start, unseal, deliver secrets, start the rest
#   scripts/stack.sh setup   unseal OpenBao and (re)issue every agent's secret_id
#   scripts/stack.sh down    stop the stack, keep volumes
#   scripts/stack.sh reset   stop the stack and delete every volume, including
#                            the local unseal material
#   scripts/stack.sh ca      print the local root CA certificate, for a
#                            one-time import into your browser (ADR 0016)
#   scripts/stack.sh test [vitest args]
#                            rebuild test_template and run Vitest in the
#                            `test` container (ADR 0015); the stack must be up
#
# The OpenBao unseal key lives in a local-only podman volume that no compose
# service mounts. Production never runs this script: an administrator unseals
# and issues secret_ids by hand.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJECT=feathers
UNSEAL_VOLUME=${PROJECT}-openbao-local-unseal
HELPER_IMAGE=docker.io/library/alpine:3.24.2@sha256:d56c381f961d307a21b3ca004cf1e3910f106644aefb1f43e654c8a56c4fd395
OPENBAO_DIR=$ROOT/containers/openbao

compose() { (cd "$ROOT" && podman-compose --profile local "$@"); }
log() { printf '\033[1mstack:\033[0m %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

agents() {
  local f
  for f in "$OPENBAO_DIR"/agents/*.hcl; do basename "$f" .hcl; done
}

# Agents of the always-on stack; test-profile agents start with `test`.
TEST_AGENTS=" test "
stack_agents() {
  local svc
  for svc in $(agents); do [[ $TEST_AGENTS == *" $svc "* ]] || echo "$svc"; done
}

running() { [[ $(podman container inspect -f '{{.State.Running}}' "$1" 2>/dev/null) == true ]]; }

# --- local unseal material -------------------------------------------------

unseal_store() { # <file> ; content on stdin
  podman volume exists "$UNSEAL_VOLUME" || podman volume create "$UNSEAL_VOLUME" >/dev/null
  podman run --rm -i --network none -v "$UNSEAL_VOLUME:/u" "$HELPER_IMAGE" \
    sh -c "umask 077; cat > /u/$1"
}

unseal_read() { # <file>
  podman volume exists "$UNSEAL_VOLUME" || return 0
  podman run --rm --network none -v "$UNSEAL_VOLUME:/u:ro" "$HELPER_IMAGE" \
    sh -c "cat /u/$1 2>/dev/null || true"
}

# --- OpenBao access --------------------------------------------------------

# Unauthenticated call inside the openbao container.
bao_plain() { podman exec -i openbao bao "$@"; }

# Authenticated call as <token>. The token travels on stdin's first line,
# never in argv or the environment of a host process; the rest of stdin goes
# to bao.
bao_as() {
  local token=$1; shift
  { printf '%s\n' "$token"; cat; } | podman exec -i openbao \
    sh -c 'IFS= read -r BAO_TOKEN; export BAO_TOKEN; exec bao "$@"' sh "$@"
}

# TOKEN is a root token for the duration of one run, revoked at its end.
TOKEN=
bao_auth() { bao_as "$TOKEN" "$@"; }
bao() { bao_auth "$@" </dev/null; }

wait_for_openbao() {
  local i rc
  for i in $(seq 60); do
    rc=0; bao_plain status >/dev/null 2>&1 || rc=$?
    # 0 = unsealed, 2 = sealed; both mean the listener answers.
    [[ $rc == 0 || $rc == 2 ]] && return 0
    sleep 1
  done
  die "OpenBao did not come up"
}

# `bao status` exits 2 while sealed; the JSON is what matters.
status_field() { { bao_plain status -format=json 2>/dev/null || true; } | jq -r ".$1"; }

init_or_unseal() {
  local key init admin
  key=$(unseal_read unseal_key)
  if [[ -z $key ]]; then
    if [[ $(status_field initialized) == true ]]; then
      die "OpenBao is initialised but the local unseal key is missing; run '$0 reset'"
    fi
    log "initialising OpenBao"
    init=$(bao_plain operator init -key-shares=1 -key-threshold=1 -format=json)
    key=$(jq -r '.unseal_keys_b64[0]' <<<"$init")
    printf '%s' "$key" | unseal_store unseal_key
    TOKEN=$(jq -r '.root_token' <<<"$init")
  fi
  if [[ $(status_field sealed) == true ]]; then
    log "unsealing OpenBao"
    bao_plain operator unseal "$key" >/dev/null
  fi
  local i
  for i in $(seq 30); do bao_plain status >/dev/null 2>&1 && break; sleep 1; done
  # Straight after init, before anything else can fail and lose the root
  # token: without the admin token, root can never be generated again.
  [[ -n $TOKEN ]] && { ensure_admin_token; return 0; }

  admin=$(unseal_read admin_token)
  [[ -n $admin ]] || die "local admin token missing; run '$0 reset'"
  bao_as "$admin" token renew </dev/null >/dev/null ||
    die "local admin token expired; run '$0 reset'"
  TOKEN=$(generate_root "$admin" "$key")
}

# Root is revoked after every run and regenerated when needed (ADR 0023).
# OpenBao refuses unauthenticated root generation by default, so it is
# started with the admin token and completed with the unseal key.
generate_root() {
  local admin=$1 key=$2 start nonce otp done_json encoded
  bao_as "$admin" operator generate-root -cancel </dev/null >/dev/null 2>&1 || true
  start=$(bao_as "$admin" operator generate-root -init -format=json </dev/null)
  nonce=$(jq -r .nonce <<<"$start")
  otp=$(jq -r .otp <<<"$start")
  done_json=$(bao_as "$admin" operator generate-root -nonce="$nonce" -format=json "$key" </dev/null)
  encoded=$(jq -r .encoded_token <<<"$done_json")
  bao_as "$admin" operator generate-root -decode="$encoded" -otp="$otp" -format=json </dev/null | jq -r .token
}

# Local stand-in for an administrator's personal account: a periodic token
# with the admin policy, kept next to the unseal key. Created once, at init.
ensure_admin_token() {
  [[ -n $(unseal_read admin_token) ]] && return 0
  bao_auth policy write admin - <"$OPENBAO_DIR/admin.hcl" >/dev/null
  bao token create -orphan -policy=admin -period=768h -display-name=local-admin \
    -field=token | unseal_store admin_token
}

# --- configuration (idempotent) --------------------------------------------

configure() {
  bao secrets list -format=json | jq -e '."kv/"' >/dev/null ||
    bao secrets enable -path=kv kv-v2 >/dev/null
  bao auth list -format=json | jq -e '."approle/"' >/dev/null ||
    bao auth enable approle >/dev/null
  bao_auth policy write admin - <"$OPENBAO_DIR/admin.hcl" >/dev/null

  local svc
  for svc in $(agents); do
    [[ -f $OPENBAO_DIR/policies/$svc.hcl ]] || die "missing policy for $svc"
    bao_auth policy write "$svc" - <"$OPENBAO_DIR/policies/$svc.hcl" >/dev/null
    bao write "auth/approle/role/$svc" token_policies="$svc" \
      token_ttl=1h token_max_ttl=24h secret_id_num_uses=0 secret_id_ttl=0 >/dev/null
    bao write "auth/approle/role/$svc/role-id" role_id="$(cat "$OPENBAO_DIR/agents/$svc.role_id")" >/dev/null
  done
}

generate() { # <generator>
  case $1 in
    random) head -c 36 /dev/urandom | base64 | tr '+/' '-_' ;;
    *) die "unknown generator $1" ;;
  esac
}

kv_get() { # <service> <key>
  { bao kv get -format=json "kv/$1" 2>/dev/null || echo '{}'; } |
    jq -r --arg k "$2" '.data.data[$k] // empty'
}

kv_set() { # <service> <key> ; value on stdin
  if bao kv get "kv/$1" >/dev/null 2>&1; then
    bao_auth kv patch "kv/$1" "$2=-" >/dev/null
  else
    bao_auth kv put "kv/$1" "$2=-" >/dev/null
  fi
}

fill_secrets() {
  local name gen targets target value svc key
  while read -r name gen targets; do
    [[ -z $name || $name == \#* ]] && continue
    value=
    for target in $targets; do
      value=$(kv_get "${target%%:*}" "${target#*:}")
      [[ -n $value ]] && break
    done
    [[ -n $value ]] || { log "generating $name"; value=$(generate "$gen"); }
    for target in $targets; do
      svc=${target%%:*} key=${target#*:}
      [[ -n $(kv_get "$svc" "$key") ]] || printf '%s' "$value" | kv_set "$svc" "$key"
    done
  done <"$OPENBAO_DIR/secrets.conf"
}

# Destroy the previous secret_ids, issue a new one response-wrapped, and
# unwrap it inside the agent container into the agent's own tmpfs.
issue_secret_ids() {
  local svc accessor wrap
  for svc in $(agents); do
    running "$svc-agent" || continue
    for accessor in $({ bao list -format=json "auth/approle/role/$svc/secret-id" 2>/dev/null || echo '[]'; } | jq -r '.[]'); do
      bao write "auth/approle/role/$svc/secret-id-accessor/destroy" secret_id_accessor="$accessor" >/dev/null
    done
    wrap=$(bao write -wrap-ttl=2m -field=wrapping_token -f "auth/approle/role/$svc/secret-id")
    printf '%s\n' "$wrap" | podman exec -i "$svc-agent" sh -c '
      set -e; umask 077
      IFS= read -r BAO_TOKEN; export BAO_TOKEN
      bao unwrap -field=secret_id > /run/agent/secret_id.new
      mv /run/agent/secret_id.new /run/agent/secret_id'
    log "issued secret_id for $svc-agent"
  done
}

wait_for_rendered() {
  local svc i
  for svc in $(agents); do
    running "$svc-agent" || continue
    for i in $(seq 60); do
      podman exec "$svc-agent" sh -c 'ls /run/secrets/* >/dev/null 2>&1' && continue 2
      sleep 1
    done
    die "$svc-agent rendered nothing; see: podman logs $svc-agent"
  done
}

setup() {
  wait_for_openbao
  init_or_unseal
  configure
  fill_secrets
  issue_secret_ids
  bao token revoke -self >/dev/null
  TOKEN=
  wait_for_rendered
  log "secrets delivered"
}

# --- commands ----------------------------------------------------------------

cmd=${1:-}
case $cmd in
  up)
    command -v jq >/dev/null || die "jq is required"
    log "building images"
    compose build
    log "starting certificates, OpenBao and agents"
    # shellcheck disable=SC2046
    compose up -d certs openbao $(stack_agents | sed 's/$/-agent/')
    setup
    log "starting the stack"
    compose up -d
    ;;
  setup) setup ;;
  ca)
    podman run --rm --network none -v "${PROJECT}_trust:/t:ro" "$HELPER_IMAGE" cat /t/ca.crt
    ;;
  test)
    shift
    compose --profile test build api test
    compose --profile test up -d test-agent
    setup
    log "rebuilding test_template"
    compose run --rm migrate node dist/migrate.js --test-template
    compose --profile test run --rm test pnpm exec vitest run "$@"
    ;;
  down) compose --profile test down ;;
  reset)
    compose --profile test down -v
    podman volume rm -f "$UNSEAL_VOLUME" >/dev/null 2>&1 || true
    ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
