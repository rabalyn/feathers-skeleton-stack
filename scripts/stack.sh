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
#                            database, its objects and OpenBao, so local
#                            data survives
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
#                            at https://e2e.<project>.localhost (ADR 0015); the
#                            local app and its data are not touched. Needs
#                            the bundle: refused after `up --dev` (ADR 0014)
#   scripts/stack.sh breakglass
#                            print the local app's break-glass email and
#                            password (ADR 0008)
#   scripts/stack.sh alerts  prove the alert path end to end (ADR 0022): make
#                            the worker log errors, then wait for Grafana's
#                            mail about them to arrive in Mailpit; then log
#                            in and out with the local break-glass account
#                            and wait for that alert's mail, both at once.
#                            Each waits first until an earlier firing of its
#                            rule has resolved (up to 20 minutes)
#   scripts/stack.sh mcp     check the coding agents' MCP servers (ADR 0026)
#                            the way .mcp.json starts them: Quasar's answers
#                            offline, the browser reaches the local origins
#                            over trusted TLS and nothing beyond them
#   scripts/stack.sh prune   remove this project's stale images and report
#                            anonymous volume leaks (scripts/prune.sh, ADR
#                            0015); `up` runs it at the end
#
# The OpenBao unseal key lives in a local-only podman volume that no compose
# service mounts. Production never runs this script: an administrator unseals
# and issues secret_ids by hand.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/product.sh
source "$ROOT/scripts/product.sh"
PROJECT=$PRODUCT
UNSEAL_VOLUME=${PROJECT}-openbao-local-unseal
HELPER_IMAGE=docker.io/library/alpine:3.24.2@sha256:d56c381f961d307a21b3ca004cf1e3910f106644aefb1f43e654c8a56c4fd395
# The Node the api and the web build run on (containers/api/Containerfile).
NODE_IMAGE=docker.io/library/node:26.10.0-alpine@sha256:b341ca66519d9a1c25d4e41f254ffb6fe403fc0f9054c62b863f0660dcc1c199
OPENBAO_DIR=$ROOT/containers/openbao

PROFILES=(--profile local)
compose() { (cd "$ROOT" && podman-compose "${PROFILES[@]}" "$@"); }

# The commit the api image is built from (ADR 0032): compose.yaml passes
# these as build arguments. The commit time, not the build time, so an
# unchanged tree builds the same image. Outside a git checkout: unknown.
if APP_COMMIT=$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null); then
  APP_COMMIT_TIME=$(git -C "$ROOT" log -1 --format=%cI)
  if [[ -n $(git -C "$ROOT" status --porcelain --untracked-files=no) ]]; then APP_DIRTY=true; else APP_DIRTY=false; fi
  export APP_COMMIT APP_COMMIT_TIME APP_DIRTY
fi
log() { printf '\033[1mstack:\033[0m %s %s\n' "$(date +%T)" "$*" >&2; }
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
    running "$(ctr "$svc-agent")" || continue
    for i in $(seq 60); do
      podman exec "$(ctr "$svc-agent")" sh -c 'ls /run/secrets/* >/dev/null 2>&1' && continue 2
      sleep 1
    done
    die "$svc-agent rendered nothing; see: podman logs $(ctr "$svc-agent")"
  done
}

# --- SAML key material (ADR 0008) -----------------------------------------

# An SP key pair: generated once, locally; deployment material in
# production. One for the api, one for NetBox (ADR 0031).
ensure_sp_keypair() { # <service> <common name>
  [[ -n $(kv_get "$1" saml_sp_key) ]] && return 0
  log "generating the SAML SP key pair of $1"
  local pems key cert
  pems=$(podman run --rm --network none --entrypoint sh localhost/$PRODUCT-certs:dev -c \
    'openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=$1" \
       -keyout /dev/stdout -out /dev/stdout 2>/dev/null' sh "$2")
  key=$(sed -n '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/p' <<<"$pems")
  cert=$(sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' <<<"$pems")
  [[ -n $key && -n $cert ]] || die "SP key generation failed"
  printf '%s\n' "$key" | kv_set "$1" saml_sp_key
  printf '%s\n' "$cert" | kv_set "$1" saml_sp_cert
}

pem_body() { sed '/-----/d' | tr -d '\n'; }

# Runs the healthcheck itself rather than waiting for podman's timer, whose
# first run comes one full interval (10s for the api) after the start.
# Host actions an end-to-end spec asks for by printing one line (ADR 0015):
# `stack-action: stop api-e2e` or `stack-action: start api-e2e`, and nothing
# else. The e2e container gets no access to Podman; this reads its output.
e2e_actions() {
  local line action
  while IFS= read -r line; do
    printf '%s\n' "$line"
    action=${line%$'\r'}
    action=${action#"${action%%[![:space:]]*}"}
    case $action in
      'stack-action: stop api-e2e') podman stop -t 5 "$(ctr api-e2e)" >/dev/null || log "stopping api-e2e failed" ;;
      'stack-action: start api-e2e') podman start "$(ctr api-e2e)" >/dev/null || log "starting api-e2e failed" ;;
    esac
  done
}

wait_healthy() { # <service> <seconds>
  local i
  for i in $(seq "$2"); do
    podman healthcheck run "$(ctr "$1")" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "$1 did not become healthy; see: podman logs $(ctr "$1")"
}

# The realm file with its placeholders filled in, as Keycloak imports it.
realm_json() {
  sed -e "s/\${PRODUCT}/$PRODUCT/g" -e "s/\${PRODUCT_HTTPS_PORT}/$PRODUCT_HTTPS_PORT/g" \
    "$ROOT/containers/idp/realm-feathers.json"
}

# Exchanges certificates with the local Keycloak: the realm's signing
# certificate goes to the api and NetBox through OpenBao, each SP
# certificate into its client in the realm, which then requires signed
# requests and encrypts.
configure_local_idp() {
  local descriptor idp_cert sp_cert current svc
  descriptor=$(podman exec "$(ctr nginx)" wget -qO- http://idp:8080/realms/feathers/protocol/saml/descriptor)
  idp_cert=$(sed -n 's/.*<ds:X509Certificate>\([^<]*\)<.*/\1/p' <<<"$descriptor" | head -1)
  [[ -n $idp_cert ]] || die "no signing certificate in the IdP descriptor"
  idp_cert=$(printf -- '-----BEGIN CERTIFICATE-----\n%s\n-----END CERTIFICATE-----\n' "$(fold -w 64 <<<"$idp_cert")")
  for svc in api netbox; do
    current=$(kv_get "$svc" saml_idp_cert)
    if [[ $current != "${idp_cert%$'\n'}" ]]; then
      printf '%s' "$idp_cert" | kv_set "$svc" saml_idp_cert
      log "stored the local IdP's signing certificate for $svc"
    fi
  done

  # One SAML client per local origin: the app's and the e2e api's (ADR 0015),
  # which share the api's SP key pair, and NetBox's (ADR 0031), with its own.
  # The realm is imported only into a fresh IdP, so a client added to the
  # realm file later is created here.
  local client
  while IFS= read -r client; do
    case $client in
      '{"clientId":"https://netbox.'*) sp_cert=$(kv_get netbox saml_sp_cert | pem_body) ;;
      *) sp_cert=$(kv_get api saml_sp_cert | pem_body) ;;
    esac
    podman exec -i "$(ctr idp)" bash -s "$sp_cert" "$client" <<'KCADM'
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
  done < <(realm_json | jq -c '.clients[]')

  # The LDAP group mapper (ADR 0031), likewise created in a realm imported
  # before it existed.
  jq -c '.components."org.keycloak.storage.UserStorageProvider"[0].subComponents."org.keycloak.storage.ldap.mappers.LDAPStorageMapper"[]
    | select(.providerId == "group-ldap-mapper")
    | . + {providerType: "org.keycloak.storage.ldap.mappers.LDAPStorageMapper"}' < <(realm_json) |
    podman exec -i "$(ctr idp)" bash -c '
set -euo pipefail
mapper=$(cat)
kc=/opt/keycloak/bin/kcadm.sh
cfg=$(mktemp)
trap "rm -f $cfg" EXIT
$kc config credentials --config "$cfg" --server http://localhost:8080 --realm master \
  --user admin --password "$(</run/secrets/admin_password)" >/dev/null
ldap=$($kc get components --config "$cfg" -r feathers -q name=ldap -q type=org.keycloak.storage.UserStorageProvider --fields id --format csv --noquotes)
[[ -n $($kc get components --config "$cfg" -r feathers -q parent="$ldap" -q name=groups --fields id --format csv --noquotes) ]] && exit 0
$kc create components --config "$cfg" -r feathers -f - -s parentId="$ldap" <<<"$mapper" >/dev/null
echo "created the LDAP group mapper"'
  log "configured the local IdP for signed requests and encryption"
}

# The api and NetBox read their SAML material at startup, so they are
# restarted once their agents have rendered the current IdP certificate.
wait_for_idp_cert() {
  local want i svc
  for svc in api netbox; do
    want=$(kv_get "$svc" saml_idp_cert)
    for i in $(seq 120); do
      [[ $(podman exec "$(ctr "$svc-agent")" cat /run/secrets/saml_idp_cert 2>/dev/null) == "$want" ]] && continue 2
      sleep 1
    done
    die "$svc-agent did not render the IdP certificate"
  done
}

idp_setup() {
  wait_healthy idp 300
  wait_for_openbao
  init_or_unseal
  configure_local_idp
  wait_for_idp_cert
  bao token revoke -self >/dev/null
  TOKEN=
  podman restart "$(ctr api)" "$(ctr netbox)" >/dev/null
  wait_healthy api 60
  wait_healthy netbox 180
  log "api and NetBox restarted with the IdP certificate"
}

# The local break-glass account (ADR 0008), made by the same bootstrap command
# an administrator runs in production. Its password is kept in OpenBao, at a
# path only this script reads, so `$0 breakglass` can show it; an account
# without a stored password gets a new one.
BREAKGLASS_EMAIL=breakglass@app.$LOCAL_DOMAIN
# The local app's public origin, as compose.yaml builds it from product.env.
APP_ORIGIN=$(local_origin app)
ensure_breakglass() {
  local count password
  count=$(podman exec -u postgres "$(ctr postgres)" psql -tAq -d app -c "SELECT count(*) FROM users WHERE auth_source = 'local'")
  # The address follows the local host names (ADR 0035): an account made
  # under an earlier one is moved to the current one.
  podman exec -i -u postgres "$(ctr postgres)" psql -q -v ON_ERROR_STOP=1 -d app -v email="$BREAKGLASS_EMAIL" <<'SQL' >/dev/null
UPDATE users SET email = :'email', updated_at = now() WHERE auth_source = 'local' AND email IS DISTINCT FROM :'email';
SQL
  wait_for_openbao
  init_or_unseal
  if [[ $count == 0 ]]; then
    password=$(podman exec "$(ctr api)" node dist/bootstrap.js --email "$BREAKGLASS_EMAIL" 2>/dev/null) ||
      die "bootstrap failed; see: podman exec $(ctr api) node dist/bootstrap.js --email $BREAKGLASS_EMAIL"
    log "created the break-glass account $BREAKGLASS_EMAIL"
  elif [[ -z $(kv_get stack breakglass_password) ]]; then
    password=$(podman exec "$(ctr api)" node dist/bootstrap.js --rotate 2>/dev/null) || die "bootstrap --rotate failed"
    log "rotated the break-glass password"
  fi
  [[ -z ${password:-} ]] || printf '%s' "$password" | kv_set stack breakglass_password
  # Where the e2e suite used to read it, before it had a database of its own.
  bao kv metadata delete kv/e2e >/dev/null 2>&1 || true
  bao token revoke -self >/dev/null
  TOKEN=
}

# Alert checks (ADR 0022). Alertmanager mails an alert group once when it
# starts firing, then stays quiet while it keeps firing, and for
# repeat_interval (4h) unless it has mailed the resolution in between. A
# check that fires a rule again before that gets no mail although delivery
# works: seen 2026-09-28, when the worker's errors during an `up` fired the
# error rule shortly before the check. So each check first waits for a
# clean slate, then fires its rule and waits for the [FIRING] mail.
alert_setup() {
  [[ -z ${ALERT_DIR:-} ]] || return 0
  ALERT_DIR=$(mktemp -d)
  trap 'rm -rf "$ALERT_DIR"' EXIT
  podman run --rm --network none -v "${PROJECT}_trust:/t:ro" "$HELPER_IMAGE" cat /t/ca.crt >"$ALERT_DIR/ca.crt"
}

# Grafana's API as its admin, from inside its container: the password
# stays there.
grafana_get() {
  podman exec "$(ctr grafana)" sh -c 'printf "user = \"admin:%s\"\n" "$(cat /run/secrets/admin_password)" |
    curl -sf -K - --cacert /trust/ca.crt --connect-to grafana:3000:127.0.0.1:3000 "https://grafana:3000$1"' sh "$1"
}

# The subjects of a rule's alert mails in Mailpit created after $2 (default:
# all), newest first.
alert_mails() {
  curl -s --cacert "$ALERT_DIR/ca.crt" -G $(local_origin mail)/api/v1/search --data-urlencode "query=subject:\"$1\"" |
    jq -r --arg title "$1" --arg since "${2:-}" '
      [.messages[]? | select(.Created > $since)
        | select((.Subject | startswith("[FIRING:") or startswith("[RESOLVED]")) and (.Subject | contains("] " + $title + " (")))]
      | sort_by(.Created) | reverse | .[].Subject'
}

# Waits until a new firing of the rule is sure to be mailed: no instance of
# it firing, and the last episode's [RESOLVED] mail sent, or the rule Normal
# for longer than the policy's group_interval (30s locally, 5m in
# production), by which Grafana has sent it (a restarted Mailpit forgets
# mails; Grafana's notification log does not).
wait_alert_quiet() {
  local uid=$1 title=$2 deadline=$((SECONDS + 1200)) interval normal latest waited=
  interval=$(grafana_get /api/v1/provisioning/policies |
    jq -r '[.group_interval | scan("([0-9]+)([hms])") | (.[0] | tonumber) * {h: 3600, m: 60, s: 1}[.[1]]] | add') ||
    die "cannot read Grafana's notification policy; see: podman logs $(ctr grafana)"
  while ((SECONDS < deadline)); do
    normal=$(grafana_get "/api/prometheus/grafana/api/v1/rules?rule_uid=$uid" | jq -r '
      [.data.groups[].rules[].alerts[]?]
      | if any(.state | startswith("Normal") | not) then "firing"
        else [.[].activeAt | sub("\\.[0-9]+"; "") | fromdateiso8601] | max // 0 end') ||
      die "cannot read the state of Grafana's rule $uid; see: podman logs $(ctr grafana)"
    latest=$(alert_mails "$title" | head -n 1)
    if [[ $normal != firing ]] && [[ $latest == "[RESOLVED]"* || $(($(date +%s) - normal)) -gt $((interval + 30)) ]]; then
      return
    fi
    [[ -n $waited ]] || log "\"$title\" fired recently; waiting until Grafana has mailed its resolution"
    waited=1
    sleep 10
  done
  die "\"$title\" did not resolve within 20 minutes; see Grafana's alert rules"
}

# Waits for the rule's [FIRING] mail created after $2.
wait_alert_mail() {
  local title=$1 since=$2 deadline=$((SECONDS + 300)) subject html
  while ((SECONDS < deadline)); do
    subject=$(alert_mails "$title" "$since" | grep -m 1 '^\[FIRING:' || true)
    if [[ -n $subject ]]; then
      # Plain text only (ADR 0022): Grafana's HTML loads a font from Google.
      html=$(curl -s --cacert "$ALERT_DIR/ca.crt" -G $(local_origin mail)/api/v1/search --data-urlencode "query=subject:\"$title\"" |
        jq -r --arg subject "$subject" --arg since "$since" \
          '[.messages[] | select(.Created > $since and .Subject == $subject)][0].ID' |
        xargs -I{} curl -s --cacert "$ALERT_DIR/ca.crt" $(local_origin mail)/api/v1/message/{} | jq -r '.HTML | length')
      [[ $html == 0 ]] || die "\"$title\" was mailed with an HTML part; Grafana must send plain text only (GF_EMAILS_CONTENT_TYPES)"
      log "alert mail arrived: $subject"
      return
    fi
    sleep 5
  done
  die "no \"$title\" mail arrived; see Grafana's alert rules and: podman logs $(ctr grafana)"
}

# The "Application errors in logs" rule: unknown jobs fail at once and log
# at `error`; Alloy ships the lines to Loki, the rule fires, Grafana mails.
# The jobs are enqueued from inside the worker, which reaches Valkey.
errors_alert_check() {
  local since
  alert_setup
  wait_alert_quiet app-errors "Application errors in logs"
  since=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  podman exec -i -w /repo/apps/api -e NODE_EXTRA_CA_CERTS=/trust/ca.crt "$(ctr worker)" \
    node --input-type=module <<'JS' || die "enqueueing the failing jobs in the worker failed"
import { readFileSync } from 'node:fs'
import { Queue } from 'bullmq'
const connection = {
  host: 'valkey', port: 6379, username: 'worker',
  password: readFileSync('/run/secrets/valkey_password', 'utf8'),
  tls: { ca: readFileSync('/trust/ca.crt', 'utf8'), servername: 'valkey' }
}
const queue = new Queue('maintenance', { prefix: 'bull', connection })
for (let i = 0; i < 8; i++) await queue.add('alert-check', {}, { attempts: 1, removeOnFail: true })
await queue.close()
JS
  wait_alert_mail "Application errors in logs" "$since"
}

# The "Break-glass login" rule, proven like the error rule: one login to
# the local app through Nginx, as the /break-glass page makes it, then
# Grafana's mail about it in Mailpit. The session is logged out again; the
# login and the logout stay in the local app's audit events.
breakglass_alert_check() {
  local password since answer
  wait_for_openbao
  init_or_unseal
  password=$(kv_get stack breakglass_password)
  bao token revoke -self >/dev/null
  TOKEN=
  [[ -n $password ]] || die "no local break-glass password; run '$0 up'"
  alert_setup
  wait_alert_quiet breakglass-login "Break-glass login"
  local -a request=(curl -s --cacert "$ALERT_DIR/ca.crt" --cookie-jar "$ALERT_DIR/cookies" --cookie "$ALERT_DIR/cookies"
    -H "Origin: $APP_ORIGIN" -o /dev/null -w '%{http_code}')
  since=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  # The password goes through stdin, never an argument.
  answer=$(printf '%s' "$password" |
    jq -Rs --arg email "$BREAKGLASS_EMAIL" '{strategy: "password", email: $email, password: .}' |
    "${request[@]}" -H 'Content-Type: application/json' --data-binary @- "$APP_ORIGIN/api/authentication")
  [[ $answer == 201 ]] || die "the break-glass login answered $answer"
  answer=$("${request[@]}" -X DELETE "$APP_ORIGIN/api/authentication")
  [[ $answer == 200 ]] || die "the break-glass logout answered $answer"
  wait_alert_mail "Break-glass login" "$since"
}

# The test directory's accounts (containers/ldap/seed/users.ldif) with
# their roles, as an administrator would assign them: a login refreshes
# directory fields but never the roles (ADR 0009, 0011). `up` gives them to
# the local `app` after every start, restoring roles changed by hand; the
# e2e run to its fresh database, where the suite's global setup then gives
# them roles of its own (ADR 0035). What the seeded roles grant is left alone.
seed_test_accounts() { # <database>
  podman exec -i -u postgres "$(ctr postgres)" psql -q -v ON_ERROR_STOP=1 -d "$1" <<'SQL' >/dev/null
CREATE TEMPORARY TABLE seed (tu_id text, given_name text, surname text, email text, role_key text);
INSERT INTO seed VALUES
  ('ad01admn', 'Ada', 'Admin', 'ada.admin@example.org', 'admin'),
  ('op01oper', 'Otto', 'Operator', 'otto.operator@example.org', 'operator'),
  ('us01user', 'Uma', 'User', 'uma.user@example.org', 'user'),
  ('us02othr', 'Olaf', 'Other', 'olaf.other@example.org', 'user');
INSERT INTO users (tu_id, given_name, surname, email, enabled, auth_source)
  SELECT tu_id, given_name, surname, email, true, 'saml' FROM seed
ON CONFLICT (tu_id) DO UPDATE SET enabled = true, updated_at = now() WHERE NOT users.enabled;
DELETE FROM user_roles USING users, seed, roles
  WHERE user_roles.user_id = users.id AND users.tu_id = seed.tu_id
    AND roles.id = user_roles.role_id AND roles.key <> seed.role_key;
INSERT INTO user_roles (user_id, role_id)
  SELECT users.id, roles.id FROM seed JOIN users USING (tu_id) JOIN roles ON roles.key = seed.role_key
ON CONFLICT DO NOTHING;
SQL
}

# The e2e suite's own api, worker and database (ADR 0015), fresh for every
# run: `app_e2e` is dropped, created like `app` in containers/postgres/initdb
# and migrated, then api-e2e and worker-e2e start on it. Nothing of the
# local `app` is touched.
E2E_DATABASE=app_e2e
E2E_BREAKGLASS_EMAIL=breakglass@e2e.$LOCAL_DOMAIN
start_e2e_api() {
  podman rm -f "$(ctr api-e2e)" "$(ctr worker-e2e)" >/dev/null 2>&1 || true
  podman exec -i -u postgres "$(ctr postgres)" psql -q -v ON_ERROR_STOP=1 -d postgres <<SQL >/dev/null
DROP DATABASE IF EXISTS $E2E_DATABASE WITH (FORCE);
CREATE DATABASE $E2E_DATABASE OWNER migrator;
REVOKE ALL ON DATABASE $E2E_DATABASE FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $E2E_DATABASE TO app_rw;
SQL
  compose run --rm -T -e DATABASE_NAME=$E2E_DATABASE migrate >/dev/null 2>&1 ||
    die "migrating $E2E_DATABASE failed; rerun without output: compose run --rm -e DATABASE_NAME=$E2E_DATABASE migrate"
  compose --profile test up -d --force-recreate --no-deps api-e2e worker-e2e >/dev/null 2>&1
  wait_healthy api-e2e 60
  wait_healthy worker-e2e 60
  seed_test_accounts "$E2E_DATABASE"
  podman exec -i -u postgres "$(ctr postgres)" psql -q -v ON_ERROR_STOP=1 -d "$E2E_DATABASE" <<'SQL' >/dev/null
-- Erased by the GDPR spec; never logs in.
WITH gone AS (
  INSERT INTO users (tu_id, given_name, surname, enabled, auth_source) VALUES
    ('us03gone', 'Greta', 'Gone', true, 'saml')
  RETURNING id
)
INSERT INTO user_roles (user_id, role_id) SELECT gone.id, roles.id FROM gone, roles WHERE roles.key = 'user';
-- Mail (ADR 0027) is not throttled here: runs follow each other within
-- the production window, on a queue prefix that outlives the database.
UPDATE settings SET value = '1000' WHERE key = 'mailSendLimitCount';
SQL
  E2E_BREAKGLASS_PASSWORD=$(podman exec "$(ctr api-e2e)" node dist/bootstrap.js --email "$E2E_BREAKGLASS_EMAIL" 2>/dev/null) ||
    die "bootstrap in api-e2e failed"
  export E2E_BREAKGLASS_PASSWORD
  log "api-e2e is up on a fresh $E2E_DATABASE"
}

setup() {
  wait_for_openbao
  init_or_unseal
  configure
  fill_secrets local
  ensure_sp_keypair api "$PRODUCT_DISPLAY_NAME local SP"
  ensure_sp_keypair netbox "$PRODUCT_DISPLAY_NAME local NetBox SP"
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
  apps/api/src/migrations apps/api/src/settings apps/api/src/mail)

# The fingerprint sits in the agent's tmpfs, so it goes with the container.
ensure_test_agent() {
  local want
  want=$(fingerprint "${TEST_AGENT_SOURCES[@]}")
  if running "$(ctr test-agent)" &&
    [[ $(podman exec "$(ctr test-agent)" cat /run/agent/fingerprint 2>/dev/null) == "$want" ]]; then
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
  printf '%s' "$want" | podman exec -i "$(ctr test-agent)" sh -c 'cat > /run/agent/fingerprint'
  log "test-agent started"
}

# The fingerprint is the template's comment, set once the build succeeded;
# migrate.ts marks it a template last, so a failed build never matches.
ensure_test_template() {
  local want
  want=$(fingerprint "${TEST_TEMPLATE_SOURCES[@]}")
  [[ $(podman exec -u postgres "$(ctr postgres)" psql -tAq -d postgres -c \
    "SELECT shobj_description(oid, 'pg_database') FROM pg_database
     WHERE datname = 'test_template' AND datistemplate") == "$want" ]] &&
    { log "test_template is current"; return 0; }
  log "rebuilding test_template"
  compose run --rm migrate node dist/migrate.js --test-template
  podman exec -u postgres "$(ctr postgres)" psql -q -d postgres -c "COMMENT ON DATABASE test_template IS '$want'"
}

# --- MCP servers (ADR 0026) ---------------------------------------------------

# A minimal MCP client over stdio: the server runs as a coprocess, each
# request waits for the answer with its id. Coprocess descriptors do not
# reach subshells, so the answer is left in MCP_REPLY.
MCP_ID=0
MCP_REPLY=
mcp_start() { # <command>...
  coproc MCP { "$@" 2>/dev/null; }
  MCP_ID=0
  mcp_request initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"stack.sh","version":"1"}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}' >&"${MCP[1]}"
}

mcp_request() { # <method> <params JSON>
  local line
  MCP_ID=$((MCP_ID + 1))
  jq -cn --argjson id "$MCP_ID" --arg method "$1" --argjson params "$2" \
    '{jsonrpc: "2.0", id: $id, $method, $params}' >&"${MCP[1]}"
  while IFS= read -r -t 120 line <&"${MCP[0]}"; do
    [[ $(jq -r '.id // empty' <<<"$line" 2>/dev/null) == "$MCP_ID" ]] && { MCP_REPLY=$line; return 0; }
  done
  die "the MCP server gave no answer to $1"
}

mcp_tool() { # <tool> <arguments JSON>; fails when the tool reports an error
  mcp_request tools/call "$(jq -cn --arg name "$1" --argjson arguments "$2" '{$name, $arguments}')"
  [[ $(jq -r '.result.isError // false' <<<"$MCP_REPLY") == false ]]
}

mcp_stop() {
  exec {MCP[1]}>&-
  wait "$MCP_PID" 2>/dev/null || true
}

mcp_check() {
  # Quasar's server runs on the host from node_modules; here in the pinned
  # Node image with no network at all, which shows it needs none.
  log "quasar: the installed docs, offline"
  mcp_start podman run --rm -i --network none --security-opt label=disable \
    -v "$ROOT:/repo:ro" -w /repo -e NO_UPDATE_NOTIFIER=1 "$NODE_IMAGE" \
    node apps/web/node_modules/@quasar/mcp/src/bin.js --project apps/web
  mcp_tool get_api '{"name": "QBtn"}' || die "quasar: get_api failed: $MCP_REPLY"
  mcp_stop

  running "$(ctr mcp-browser)" || die "mcp-browser is not running; run '$0 up'"
  log "playwright: the local origins over trusted TLS, nothing beyond"
  mcp_start bash "$ROOT/scripts/mcp-browser.sh"
  mcp_tool browser_navigate "{\"url\": \"$APP_ORIGIN/login\"}" ||
    die "playwright: the app did not load: $MCP_REPLY"
  mcp_tool browser_navigate "{\"url\": \"$(local_origin idp)/realms/feathers/\"}" ||
    die "playwright: the IdP did not load: $MCP_REPLY"
  # By address, so the check does not depend on name resolution.
  ! mcp_tool browser_navigate '{"url": "https://1.1.1.1/"}' ||
    die "playwright: the browser reached the internet"
  mcp_stop
  log "MCP servers answer as .mcp.json starts them"
}

# podman-compose stops every container at once on `down`, ignoring
# depends_on; Alloy goes first so it can ship what it holds while Loki is
# still there (compose.yaml orders them for the production units).
stack_down() {
  podman stop "$(ctr alloy)" >/dev/null 2>&1 || true
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
        podman rm -f "$(ctr web)" >/dev/null 2>&1 || true
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
    # container whose image was rebuilt, so every container `up` manages is
    # removed here and each service created anew below, exactly once. Not
    # with --force-recreate: podman-compose then also recreates every
    # service that depends on the one named, stopping them a batch at a
    # time, each batch waiting out the stop timeout of a container that
    # ignores its signal; an `up` recreated most services up to three times
    # and spent minutes stopping them (measured 2026-10-06). One removal of
    # all of them stops them in parallel. OpenBao is among them, and starts
    # sealed, as it did when the certificates' dependents were recreated.
    log "removing the previous containers"
    # shellcheck disable=SC2046
    podman rm --force --ignore $(for svc in certs openbao $(stack_agents | sed 's/$/-agent/') $(app_services); do ctr "$svc"; echo; done) >/dev/null
    log "issuing certificates"
    compose up -d --no-deps certs >/dev/null 2>&1
    podman wait "$(ctr certs)" >/dev/null
    [[ $(podman inspect -f '{{.State.ExitCode}}' "$(ctr certs)") == 0 ]] || die "certs failed; see: podman logs $(ctr certs)"
    log "starting OpenBao and agents"
    compose up -d --no-deps openbao >/dev/null 2>&1
    # Agents read their configuration only at start, so they are recreated;
    # setup issues fresh secret_ids anyway. (`podman restart` refuses: the
    # dependency chain ends at the exited one-shot `certs`.)
    # shellcheck disable=SC2046
    compose up -d --no-deps $(stack_agents | sed 's/$/-agent/') >/dev/null 2>&1
    setup
    # The uptime check's target (ADR 0022): deployment configuration, here
    # the local app's origin.
    printf '%s\n' "# Written by scripts/stack.sh from product.env (ADR 0022, 0035)." \
      "- targets: ['$APP_ORIGIN/api/ping']" >"$ROOT/containers/prometheus/targets/uptime.yml"
    log "starting the stack"
    # shellcheck disable=SC2046
    compose up -d --no-deps $(app_services | grep -vxE 'migrate|api|worker|backup|netbox|netbox-worker|netbox-setup') >/dev/null 2>&1
    # --no-deps drops depends_on conditions, so migrate waits here explicitly.
    wait_healthy postgres 120
    log "migrating the database"
    compose up -d --no-deps migrate >/dev/null 2>&1
    podman wait "$(ctr migrate)" >/dev/null
    [[ $(podman inspect -f '{{.State.ExitCode}}' "$(ctr migrate)") == 0 ]] || die "migrate failed; see: podman logs $(ctr migrate)"
    # The api and the worker refuse to start without their runtime settings
    # (ADR 0025), which migrate has just seeded. On a first start the api
    # also lacks the IdP's certificate until idp_setup below, which restarts
    # it and waits for it, so only the worker is waited for here.
    log "starting api, worker and backup"
    compose up -d --no-deps api worker backup >/dev/null 2>&1
    wait_healthy worker 60
    # NetBox's migrations and seed (ADR 0031), then NetBox itself.
    log "migrating and seeding NetBox"
    compose up -d --no-deps netbox-setup >/dev/null 2>&1
    podman wait "$(ctr netbox-setup)" >/dev/null
    [[ $(podman inspect -f '{{.State.ExitCode}}' "$(ctr netbox-setup)") == 0 ]] || die "netbox-setup failed; see: podman logs $(ctr netbox-setup)"
    log "starting NetBox"
    compose up -d --no-deps netbox netbox-worker >/dev/null 2>&1
    wait_healthy netbox 180
    # The local target is ours to initialise (ADR 0017); a run never does.
    podman exec -u backup "$(ctr backup)" node dist/backup.js init >/dev/null ||
      die "initialising the backup target failed; see: podman logs $(ctr backup)"
    log "configuring the local IdP"
    idp_setup
    ensure_breakglass
    seed_test_accounts app
    log "test accounts have their roles: ad01admn admin, op01oper operator, us01user and us02othr user"
    # A leak report does not fail `up`; scripts/ci.sh fails on it.
    "$ROOT/scripts/prune.sh" || true
    ;;
  setup) setup ;;
  idp) idp_setup ;;
  ca)
    podman run --rm --network none -v "${PROJECT}_trust:/t:ro" "$HELPER_IMAGE" cat /t/ca.crt
    ;;
  test)
    shift
    log "building the api and test images"
    compose --profile test build api test
    ensure_test_agent
    ensure_test_template
    log "running Vitest"
    compose --profile test run --rm -T test pnpm exec vitest run "$@"
    ;;
  e2e)
    shift
    # The suite exercises the built bundle (ADR 0014); under --dev nginx
    # proxies every origin, the e2e one included, to the Vite dev server.
    [[ -z $(podman inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(ctr nginx)" 2>/dev/null |
      sed -n 's/^NGINX_WEB_UPSTREAM=//p') ]] ||
      die "nginx serves the Vite dev server; run '$0 up' (without --dev) first"
    log "building the e2e image"
    compose --profile test build e2e
    # api-e2e, worker-e2e, their database and their buckets' contents
    # exist for the run only: the buckets are emptied before the run and
    # after it.
    trap 'podman exec "$(ctr api-e2e)" node dist/empty-bucket.js >/dev/null 2>&1 || true; podman rm -f "$(ctr api-e2e)" "$(ctr worker-e2e)" >/dev/null 2>&1 || true' EXIT
    start_e2e_api
    podman exec "$(ctr api-e2e)" node dist/empty-bucket.js >/dev/null || die "could not empty the e2e buckets"
    log "running Playwright"
    compose --profile test run --rm -T e2e pnpm exec playwright test "$@" 2>&1 | e2e_actions
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
    # The two rules form separate alert groups, so both checks run at once.
    alert_setup
    log "logging errors in the worker and in with the break-glass account, then waiting for both alert mails"
    errors_alert_check & errors=$!
    breakglass_alert_check & breakglass=$!
    failed=
    wait "$errors" || failed=1
    wait "$breakglass" || failed=1
    [[ -z $failed ]] || die "an alert check failed; see above"
    ;;
  mcp) mcp_check ;;
  prune) "$ROOT/scripts/prune.sh" ;;
  down) stack_down ;;
  reset)
    case ${2:-} in
      "") keep=" ${PROJECT}_certs-ca " ;;
      --ca) keep=" " ;;
      # The local app's data survives: its database (with the test
      # databases, which are rebuilt anyway) and the OpenBao values and
      # unseal key its roles' passwords depend on. Everything else starts
      # from nothing, as on a fresh runner. `scripts/ci.sh --cold` uses this.
      # The objects go with the database that references them (ADR 0020).
      --keep-data) keep=" ${PROJECT}_certs-ca ${PROJECT}_postgres-data ${PROJECT}_s3-data ${PROJECT}_openbao-data $UNSEAL_VOLUME " ;;
      *) die "usage: $0 reset [--ca|--keep-data]" ;;
    esac
    stack_down
    for volume in $(podman volume ls -q --filter "label=io.podman.compose.project=$PROJECT") $UNSEAL_VOLUME; do
      [[ $keep == *" $volume "* ]] || podman volume rm -f "$volume" >/dev/null 2>&1 || true
    done
    case ${2:-} in
      "") log "kept the local root CA; '$0 reset --ca' deletes it" ;;
      --keep-data) log "kept the local root CA, the app's database, its objects and OpenBao; '$0 reset' deletes them" ;;
    esac
    ;;
  *) sed -n '2,49p' "$0"; exit 2 ;;
esac
