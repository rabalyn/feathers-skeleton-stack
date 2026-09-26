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
#   scripts/stack.sh reset [--ca|--keep-data]
#                            stop the stack and delete every volume, including
#                            the local unseal material, but keep the local root
#                            CA so the browser import stays valid (ADR 0016);
#                            --ca deletes the CA too; --keep-data also keeps the
#                            database and OpenBao, so local data survives
#   scripts/stack.sh ca      print the local root CA certificate, for a
#                            one-time import into your browser (ADR 0016)
#   scripts/stack.sh test [vitest args]
#                            run Vitest in the `test` container (ADR 0015);
#                            the stack must be up. test-agent and
#                            test_template are reused while the sources they
#                            were made from are unchanged
#   scripts/stack.sh e2e [playwright args]
#                            run the Playwright suite in the `e2e` container
#                            against api-e2e on a fresh database of its own,
#                            at https://e2e.localhost:8443 (ADR 0015); the
#                            local app and its data are not touched. Needs
#                            the bundle: refused after `up --dev` (ADR 0014)
#   scripts/stack.sh breakglass
#                            print the local app's break-glass email and
#                            password (ADR 0008)
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

# Every agent exists locally; see openbao-lib.sh.
AGENTS=$(agents | tr '\n' ' ')
# shellcheck source=scripts/openbao-lib.sh
source "$ROOT/scripts/openbao-lib.sh"

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

# --- agents ----------------------------------------------------------------

wait_for_rendered() { # [<service>...]
  local svc i
  for svc in ${*:-$(agents)}; do
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

# Runs the healthcheck itself rather than waiting for podman's timer, whose
# first run comes one full interval (10s for the api) after the start.
wait_healthy() { # <container> <seconds>
  local i
  for i in $(seq "$2"); do
    podman healthcheck run "$1" >/dev/null 2>&1 && return 0
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
  # One SAML client per local origin: the app's and the e2e api's (ADR 0015).
  # Both share the api's SP key pair. The realm is imported only into a fresh
  # IdP, so a client added to the realm file later is created here.
  local client
  while IFS= read -r client; do
    podman exec -i idp bash -s "$sp_cert" "$client" <<'KCADM'
set -euo pipefail
kc=/opt/keycloak/bin/kcadm.sh
cfg=$(mktemp)
trap 'rm -f "$cfg"' EXIT
$kc config credentials --config "$cfg" --server http://localhost:8080 --realm master \
  --user admin --password "$(</run/secrets/admin_password)" >/dev/null
client_id=$(sed -n 's/^{"clientId":"\([^"]*\)".*/\1/p' <<<"$2")
id=$($kc get clients --config "$cfg" -r feathers -q "clientId=$client_id" --fields id --format csv --noquotes)
if [[ -z $id ]]; then
  $kc create clients --config "$cfg" -r feathers -f - <<<"$2" >/dev/null
  id=$($kc get clients --config "$cfg" -r feathers -q "clientId=$client_id" --fields id --format csv --noquotes)
fi
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
  done < <(jq -c '.clients[]' "$ROOT/containers/idp/realm-feathers.json")
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

# The local break-glass account (ADR 0008), made by the same bootstrap command
# an administrator runs in production. Its password is kept in OpenBao, at a
# path only this script reads, so `$0 breakglass` can show it; an account
# without a stored password gets a new one.
BREAKGLASS_EMAIL=breakglass@app.localhost
ensure_breakglass() {
  local count password
  count=$(podman exec -u postgres postgres psql -tAq -d app -c "SELECT count(*) FROM users WHERE auth_source = 'local'")
  wait_for_openbao
  init_or_unseal
  if [[ $count == 0 ]]; then
    password=$(podman exec api node dist/bootstrap.js --email "$BREAKGLASS_EMAIL" 2>/dev/null) ||
      die "bootstrap failed; see: podman exec api node dist/bootstrap.js --email $BREAKGLASS_EMAIL"
    log "created the break-glass account $BREAKGLASS_EMAIL"
  elif [[ -z $(kv_get stack breakglass_password) ]]; then
    password=$(podman exec api node dist/bootstrap.js --rotate 2>/dev/null) || die "bootstrap --rotate failed"
    log "rotated the break-glass password"
  fi
  [[ -z ${password:-} ]] || printf '%s' "$password" | kv_set stack breakglass_password
  # Where the e2e suite used to read it, before it had a database of its own.
  bao kv metadata delete kv/e2e >/dev/null 2>&1 || true
  bao token revoke -self >/dev/null
  TOKEN=
}

# The e2e suite's own api and database (ADR 0015), fresh for every run:
# `app_e2e` is dropped, created like `app` in containers/postgres/initdb and
# migrated, then api-e2e starts on it. Nothing of the local `app` is touched.
E2E_DATABASE=app_e2e
E2E_BREAKGLASS_EMAIL=breakglass@e2e.localhost
start_e2e_api() {
  podman rm -f api-e2e >/dev/null 2>&1 || true
  podman exec -i -u postgres postgres psql -q -v ON_ERROR_STOP=1 -d postgres <<SQL >/dev/null
DROP DATABASE IF EXISTS $E2E_DATABASE WITH (FORCE);
CREATE DATABASE $E2E_DATABASE OWNER migrator;
REVOKE ALL ON DATABASE $E2E_DATABASE FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $E2E_DATABASE TO app_rw;
SQL
  compose run --rm -T -e DATABASE_NAME=$E2E_DATABASE migrate >/dev/null 2>&1 ||
    die "migrating $E2E_DATABASE failed; rerun without output: compose run --rm -e DATABASE_NAME=$E2E_DATABASE migrate"
  compose --profile test up -d --force-recreate --no-deps api-e2e >/dev/null 2>&1
  wait_healthy api-e2e 60
  # The test accounts with their roles, as an administrator would assign
  # them; a login refreshes directory fields but never the role (ADR 0009,
  # 0011).
  podman exec -i -u postgres postgres psql -q -v ON_ERROR_STOP=1 -d "$E2E_DATABASE" <<'SQL' >/dev/null
INSERT INTO users (tu_id, given_name, surname, role, enabled, auth_source) VALUES
  ('ad01admn', 'Ada', 'Admin', 'admin', true, 'saml'),
  ('op01oper', 'Otto', 'Operator', 'operator', true, 'saml'),
  ('us01user', 'Uma', 'User', 'user', true, 'saml'),
  ('us02othr', 'Olaf', 'Other', 'user', true, 'saml');
SQL
  E2E_BREAKGLASS_PASSWORD=$(podman exec api-e2e node dist/bootstrap.js --email "$E2E_BREAKGLASS_EMAIL" 2>/dev/null) ||
    die "bootstrap in api-e2e failed"
  export E2E_BREAKGLASS_PASSWORD
  log "api-e2e is up on a fresh $E2E_DATABASE"
}

setup() {
  wait_for_openbao
  init_or_unseal
  configure
  fill_secrets local
  ensure_sp_keypair
  issue_secret_ids
  bao token revoke -self >/dev/null
  TOKEN=
  wait_for_rendered
  log "secrets delivered"
}

# `test` reuses what an earlier run left in place (ADR 0015): a running
# test-agent and a test_template, each while a fingerprint of the sources it
# was made from still matches. The template's sources are what migrate.ts
# runs for --test-template; a new import there belongs in this list.
fingerprint() { # <path>...
  (cd "$ROOT" && find "$@" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
}
TEST_AGENT_SOURCES=(compose.yaml containers/openbao scripts/openbao-lib.sh)
TEST_TEMPLATE_SOURCES=(apps/api/src/migrate.ts apps/api/src/migration-support.ts
  apps/api/src/migrations apps/api/src/settings)

# The fingerprint sits in the agent's tmpfs, so it goes with the container.
ensure_test_agent() {
  local want
  want=$(fingerprint "${TEST_AGENT_SOURCES[@]}")
  if running test-agent &&
    [[ $(podman exec test-agent cat /run/agent/fingerprint 2>/dev/null) == "$want" ]]; then
    log "test-agent is current"
    return 0
  fi
  # OpenBao first: an agent started without a secret_id backs off for
  # minutes, and would miss the one issued below.
  wait_for_openbao
  init_or_unseal
  # Recreated: it reads its templates at start, and needs a new secret_id.
  compose --profile test up -d --force-recreate --no-deps test-agent >/dev/null 2>&1
  configure
  fill_secrets local
  issue_secret_ids test
  bao token revoke -self >/dev/null
  TOKEN=
  wait_for_rendered test
  printf '%s' "$want" | podman exec -i test-agent sh -c 'cat > /run/agent/fingerprint'
  log "test-agent started"
}

# The fingerprint is the template's comment, set once the build succeeded;
# migrate.ts marks it a template last, so a failed build never matches.
ensure_test_template() {
  local want
  want=$(fingerprint "${TEST_TEMPLATE_SOURCES[@]}")
  [[ $(podman exec -u postgres postgres psql -tAq -d postgres -c \
    "SELECT shobj_description(oid, 'pg_database') FROM pg_database
     WHERE datname = 'test_template' AND datistemplate") == "$want" ]] &&
    { log "test_template is current"; return 0; }
  log "rebuilding test_template"
  compose run --rm migrate node dist/migrate.js --test-template
  podman exec -u postgres postgres psql -q -d postgres -c "COMMENT ON DATABASE test_template IS '$want'"
}

# podman-compose stops every container at once on `down`, ignoring
# depends_on; Alloy goes first so it can ship what it holds while Loki is
# still there (compose.yaml orders them for the production units).
stack_down() {
  podman stop alloy >/dev/null 2>&1 || true
  compose --profile test --profile dev down
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
    compose up -d --force-recreate --no-deps $(app_services | grep -vxE 'migrate|worker|backup') >/dev/null 2>&1
    # --no-deps drops depends_on conditions, so migrate waits here explicitly.
    wait_healthy postgres 120
    compose up -d --force-recreate --no-deps migrate >/dev/null 2>&1
    podman wait migrate >/dev/null
    [[ $(podman inspect -f '{{.State.ExitCode}}' migrate) == 0 ]] || die "migrate failed; see: podman logs migrate"
    # The worker refuses to start without its runtime settings (ADR 0025),
    # which migrate has just seeded.
    compose up -d --force-recreate --no-deps worker backup >/dev/null 2>&1
    wait_healthy worker 60
    # The local target is ours to initialise (ADR 0017); a run never does.
    podman exec -u backup backup node dist/backup.js init >/dev/null ||
      die "initialising the backup target failed; see: podman logs backup"
    idp_setup
    ensure_breakglass
    ;;
  setup) setup ;;
  idp) idp_setup ;;
  ca)
    podman run --rm --network none -v "${PROJECT}_trust:/t:ro" "$HELPER_IMAGE" cat /t/ca.crt
    ;;
  test)
    shift
    compose --profile test build api test
    ensure_test_agent
    ensure_test_template
    compose --profile test run --rm -T test pnpm exec vitest run "$@"
    ;;
  e2e)
    shift
    # The suite exercises the built bundle (ADR 0014); under --dev nginx
    # proxies every origin, the e2e one included, to the Vite dev server.
    [[ -z $(podman inspect -f '{{range .Config.Env}}{{println .}}{{end}}' nginx 2>/dev/null |
      sed -n 's/^NGINX_WEB_UPSTREAM=//p') ]] ||
      die "nginx serves the Vite dev server; run '$0 up' (without --dev) first"
    compose --profile test build e2e
    # api-e2e, its database and its bucket's contents exist for the run
    # only: the bucket is emptied before the run and after it.
    trap 'podman exec api-e2e node dist/empty-bucket.js >/dev/null 2>&1 || true; podman rm -f api-e2e >/dev/null 2>&1 || true' EXIT
    start_e2e_api
    podman exec api-e2e node dist/empty-bucket.js >/dev/null || die "could not empty the e2e bucket"
    compose --profile test run --rm -T e2e pnpm exec playwright test "$@"
    ;;
  breakglass)
    # The local app's break-glass login, for trying /break-glass by hand.
    wait_for_openbao
    init_or_unseal
    password=$(kv_get stack breakglass_password)
    bao token revoke -self >/dev/null
    TOKEN=
    [[ -n $password ]] || die "no local break-glass password; run '$0 up'"
    printf '%s\n%s\n' "$BREAKGLASS_EMAIL" "$password"
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
  down) stack_down ;;
  reset)
    case ${2:-} in
      "") keep=" ${PROJECT}_certs-ca " ;;
      --ca) keep=" " ;;
      # The local app's data survives: its database (with the test
      # databases, which are rebuilt anyway) and the OpenBao values and
      # unseal key its roles' passwords depend on. Everything else starts
      # from nothing, as on a fresh runner. `scripts/ci.sh --cold` uses this.
      --keep-data) keep=" ${PROJECT}_certs-ca ${PROJECT}_postgres-data ${PROJECT}_openbao-data $UNSEAL_VOLUME " ;;
      *) die "usage: $0 reset [--ca|--keep-data]" ;;
    esac
    stack_down
    for volume in $(podman volume ls -q --filter "label=io.podman.compose.project=$PROJECT") $UNSEAL_VOLUME; do
      [[ $keep == *" $volume "* ]] || podman volume rm -f "$volume" >/dev/null 2>&1 || true
    done
    case ${2:-} in
      "") log "kept the local root CA; '$0 reset --ca' deletes it" ;;
      --keep-data) log "kept the local root CA, the app's database and OpenBao; '$0 reset' deletes them" ;;
    esac
    ;;
  *) sed -n '2,29p' "$0"; exit 2 ;;
esac
