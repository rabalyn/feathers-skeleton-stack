#!/usr/bin/env bash
# Local and CI stack control (ADR 0001, 0023).
#
#   scripts/stack.sh up [--dev]
#                            build, start, unseal, deliver secrets, start the
#                            rest; --dev adds the Vite dev server with hot
#                            reload behind Nginx (ADR 0014), plain `up`
#                            serves the built bundle
#   scripts/stack.sh setup   unseal OpenBao and (re)issue every agent's secret_id
#   scripts/stack.sh idp     exchange certificates with the local IdP and
#                            restart the api
#   scripts/stack.sh down    stop the stack, keep volumes
#   scripts/stack.sh reset [--ca]
#                            stop the stack and delete every volume, including
#                            the local unseal material, but keep the local root
#                            CA so the browser import stays valid (ADR 0016);
#                            --ca deletes the CA too
#   scripts/stack.sh ca      print the local root CA certificate, for a
#                            one-time import into your browser (ADR 0016)
#   scripts/stack.sh test [vitest args]
#                            rebuild test_template and run Vitest in the
#                            `test` container (ADR 0015); the stack must be up
#   scripts/stack.sh e2e [playwright args]
#                            run the Playwright suite in the `e2e` container
#                            against the running stack (ADR 0015)
#   scripts/stack.sh alerts  prove the alert path end to end (ADR 0022): make
#                            the worker log errors, then wait for Grafana's
#                            mail about them to arrive in Mailpit
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

PROFILES=(--profile local)
compose() { (cd "$ROOT" && podman-compose "${PROFILES[@]}" "$@"); }
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

# Everything except the one-shot certs job, OpenBao and the agents.
app_services() {
  compose config --services 2>/dev/null | grep -vxE 'certs|openbao|.*-agent'
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

# --- SAML key material (ADR 0008) -----------------------------------------

# The SP key pair: generated once, locally; deployment material in production.
ensure_sp_keypair() {
  [[ -n $(kv_get api saml_sp_key) ]] && return 0
  log "generating the SAML SP key pair"
  local pems key cert
  pems=$(podman run --rm --network none --entrypoint sh localhost/feathers-certs:dev -c \
    'openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=claude-feathers local SP" \
       -keyout /dev/stdout -out /dev/stdout 2>/dev/null')
  key=$(sed -n '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/p' <<<"$pems")
  cert=$(sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' <<<"$pems")
  [[ -n $key && -n $cert ]] || die "SP key generation failed"
  printf '%s\n' "$key" | kv_set api saml_sp_key
  printf '%s\n' "$cert" | kv_set api saml_sp_cert
}

pem_body() { sed '/-----/d' | tr -d '\n'; }

wait_healthy() { # <container> <seconds>
  local i
  for i in $(seq "$2"); do
    [[ $(podman inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null) == healthy ]] && return 0
    sleep 1
  done
  die "$1 did not become healthy; see: podman logs $1"
}

# Exchanges certificates with the local Keycloak: the realm's signing
# certificate goes to the api through OpenBao, the SP certificate into the
# realm's client, which then requires signed requests and encrypts.
configure_local_idp() {
  local descriptor idp_cert sp_cert current
  descriptor=$(podman exec nginx wget -qO- http://idp:8080/realms/feathers/protocol/saml/descriptor)
  idp_cert=$(sed -n 's/.*<ds:X509Certificate>\([^<]*\)<.*/\1/p' <<<"$descriptor" | head -1)
  [[ -n $idp_cert ]] || die "no signing certificate in the IdP descriptor"
  idp_cert=$(printf -- '-----BEGIN CERTIFICATE-----\n%s\n-----END CERTIFICATE-----\n' "$(fold -w 64 <<<"$idp_cert")")
  current=$(kv_get api saml_idp_cert)
  if [[ $current != "${idp_cert%$'\n'}" ]]; then
    printf '%s' "$idp_cert" | kv_set api saml_idp_cert
    log "stored the local IdP's signing certificate"
  fi

  sp_cert=$(kv_get api saml_sp_cert | pem_body)
  podman exec -i idp bash -s "$sp_cert" <<'KCADM'
set -euo pipefail
kc=/opt/keycloak/bin/kcadm.sh
cfg=$(mktemp)
trap 'rm -f "$cfg"' EXIT
$kc config credentials --config "$cfg" --server http://localhost:8080 --realm master \
  --user admin --password "$(</run/secrets/admin_password)" >/dev/null
id=$($kc get clients --config "$cfg" -r feathers -q 'clientId=https://app.localhost:8443/api/auth/saml/metadata' --fields id --format csv --noquotes)
$kc update "clients/$id" --config "$cfg" -r feathers \
  -s 'attributes."saml_name_id_format"=transient' \
  -s 'attributes."saml.client.signature"=true' \
  -s "attributes.\"saml.signing.certificate\"=$1" \
  -s 'attributes."saml.encrypt"=true' \
  -s "attributes.\"saml.encryption.certificate\"=$1" \
  -s 'attributes."saml.encryption.algorithm"=http://www.w3.org/2009/xmlenc11#aes256-gcm' \
  -s 'attributes."saml.encryption.keyAlgorithm"=http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p' \
  -s 'attributes."saml.encryption.digestMethod"=http://www.w3.org/2000/09/xmldsig#sha1'
KCADM
  log "configured the local IdP for signed requests and encryption"
}

# The api reads its SAML material at startup, so it is restarted once the
# api-agent has rendered the current IdP certificate.
wait_for_idp_cert() {
  local want i
  want=$(kv_get api saml_idp_cert)
  for i in $(seq 120); do
    [[ $(podman exec api-agent cat /run/secrets/saml_idp_cert 2>/dev/null) == "$want" ]] && return 0
    sleep 1
  done
  die "api-agent did not render the IdP certificate"
}

idp_setup() {
  wait_healthy idp 300
  wait_for_openbao
  init_or_unseal
  configure_local_idp
  wait_for_idp_cert
  bao token revoke -self >/dev/null
  TOKEN=
  podman restart api >/dev/null
  wait_healthy api 60
  log "api restarted with the IdP certificate"
}

setup() {
  wait_for_openbao
  init_or_unseal
  configure
  fill_secrets
  ensure_sp_keypair
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
    case ${2:-} in
      --dev)
        PROFILES+=(--profile dev)
        export NGINX_WEB_UPSTREAM=web:5173
        ;;
      "")
        # Leaving dev mode: nginx serves the bundle again.
        podman rm -f web >/dev/null 2>&1 || true
        ;;
      *) die "usage: $0 up [--dev]" ;;
    esac
    command -v jq >/dev/null || die "jq is required"
    # Dozzle reads container output through the rootless Podman API (ADR 0002).
    [[ -S ${XDG_RUNTIME_DIR:-}/podman/podman.sock ]] ||
      die "the Podman API socket is missing; run: systemctl --user enable --now podman.socket"
    log "building images"
    compose build
    # podman-compose neither reruns a completed one-shot nor recreates a
    # container whose image was rebuilt, so services are recreated
    # explicitly. OpenBao is not: recreating it seals it.
    log "issuing certificates"
    compose up -d --force-recreate --no-deps certs >/dev/null 2>&1
    podman wait certs >/dev/null
    [[ $(podman inspect -f '{{.State.ExitCode}}' certs) == 0 ]] || die "certs failed; see: podman logs certs"
    log "starting OpenBao and agents"
    compose up -d --no-deps openbao >/dev/null 2>&1
    # Agents read their configuration only at start, so they are recreated;
    # setup issues fresh secret_ids anyway. (`podman restart` refuses: the
    # dependency chain ends at the exited one-shot `certs`.)
    # shellcheck disable=SC2046
    compose up -d --force-recreate --no-deps $(stack_agents | sed 's/$/-agent/') >/dev/null 2>&1
    setup
    log "starting the stack"
    # shellcheck disable=SC2046
    compose up -d --force-recreate --no-deps $(app_services | grep -vxE 'migrate|worker') >/dev/null 2>&1
    # --no-deps drops depends_on conditions, so migrate waits here explicitly.
    wait_healthy postgres 120
    compose up -d --force-recreate --no-deps migrate >/dev/null 2>&1
    podman wait migrate >/dev/null
    [[ $(podman inspect -f '{{.State.ExitCode}}' migrate) == 0 ]] || die "migrate failed; see: podman logs migrate"
    # The worker refuses to start without its runtime settings (ADR 0025),
    # which migrate has just seeded.
    compose up -d --force-recreate --no-deps worker >/dev/null 2>&1
    wait_healthy worker 60
    idp_setup
    ;;
  setup) setup ;;
  idp) idp_setup ;;
  ca)
    podman run --rm --network none -v "${PROJECT}_trust:/t:ro" "$HELPER_IMAGE" cat /t/ca.crt
    ;;
  test)
    shift
    compose --profile test build api test
    # Recreated like every agent in `up`: it reads its templates at start.
    compose --profile test up -d --force-recreate --no-deps test-agent >/dev/null 2>&1
    setup
    log "rebuilding test_template"
    compose run --rm migrate node dist/migrate.js --test-template
    compose --profile test run --rm -T test pnpm exec vitest run "$@"
    ;;
  e2e)
    shift
    compose --profile test build e2e
    # The test accounts with their roles, as an administrator would assign
    # them; a login refreshes directory fields but never the role (ADR 0009,
    # 0011). Idempotent, and resets what an earlier run changed.
    podman exec -i -u postgres postgres psql -q -v ON_ERROR_STOP=1 -d app <<'SQL' >/dev/null
INSERT INTO users (tu_id, given_name, surname, role, enabled, auth_source) VALUES
  ('ad01admn', 'Ada', 'Admin', 'admin', true, 'saml'),
  ('op01oper', 'Otto', 'Operator', 'operator', true, 'saml'),
  ('us01user', 'Uma', 'User', 'user', true, 'saml'),
  ('us02othr', 'Olaf', 'Other', 'user', true, 'saml')
ON CONFLICT (tu_id) DO UPDATE SET role = excluded.role, enabled = excluded.enabled;
SQL
    compose --profile test run --rm -T e2e pnpm exec playwright test "$@"
    ;;
  alerts)
    # Unknown jobs fail at once and log at `error`: Alloy ships the lines to
    # Loki, the "Application errors in logs" rule fires, Grafana mails.
    # Runs inside the worker, which reaches Valkey and Mailpit.
    log "logging errors in the worker, then waiting for the alert mail"
    podman exec -i -w /repo/apps/api -e NODE_EXTRA_CA_CERTS=/trust/ca.crt worker \
      node --input-type=module <<'JS' || die "no alert mail arrived; see Grafana's alert rules and: podman logs grafana"
import { readFileSync } from 'node:fs'
import { Queue } from 'bullmq'
const connection = {
  host: 'valkey', port: 6379, username: 'worker',
  password: readFileSync('/run/secrets/valkey_password', 'utf8'),
  tls: { ca: readFileSync('/trust/ca.crt', 'utf8'), servername: 'valkey' }
}
const since = new Date().toISOString()
const queue = new Queue('maintenance', { prefix: 'bull', connection })
for (let i = 0; i < 8; i++) await queue.add('alert-check', {}, { attempts: 1, removeOnFail: true })
await queue.close()
const query = encodeURIComponent('subject:"Application errors in logs"')
const deadline = Date.now() + 5 * 60_000
while (Date.now() < deadline) {
  const response = await fetch(`https://mail:8025/api/v1/search?query=${query}`)
  const { messages = [] } = await response.json()
  const arrived = messages.find((message) => message.Created > since)
  if (arrived) {
    console.log(`alert mail arrived: ${arrived.Subject}`)
    process.exit(0)
  }
  await new Promise((resolve) => setTimeout(resolve, 5000))
}
process.exit(1)
JS
    ;;
  down) compose --profile test --profile dev down ;;
  reset)
    compose --profile test --profile dev down
    keep=${PROJECT}_certs-ca
    [[ ${2:-} == --ca ]] && keep=
    for volume in $(podman volume ls -q --filter "label=io.podman.compose.project=$PROJECT"); do
      [[ $volume == "$keep" ]] || podman volume rm -f "$volume" >/dev/null
    done
    [[ -n $keep ]] && log "kept the local root CA; '$0 reset --ca' deletes it"
    podman volume rm -f "$UNSEAL_VOLUME" >/dev/null 2>&1 || true
    ;;
  *) sed -n '2,29p' "$0"; exit 2 ;;
esac
