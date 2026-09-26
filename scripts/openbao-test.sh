#!/usr/bin/env bash
# Tests scripts/openbao.sh, the production OpenBao procedure (ADR 0023),
# against a throwaway OpenBao and one stand-in agent container, on a network
# of their own. Nothing of the running stack is touched: the containers carry
# a prefix the procedure is told about. Part of scripts/ci.sh.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENBAO_IMAGE=$(sed -n 's/^ *image: \(docker.io\/openbao\/openbao@sha256:[0-9a-f]*\).*/\1/p' "$ROOT/compose.yaml" | head -1)
P=openbao-test
NET=$P
# Without a controlling terminal: openbao.sh reads passwords and keys from
# /dev/tty when there is one, which would prompt whoever started CI instead
# of taking the test's input from stdin.
BAO=(setsid -w env OPENBAO_CONTAINER=$P AGENT_PREFIX=$P- "$ROOT/scripts/openbao.sh")

failures=0
check() { # <description> <command...>
  if "${@:2}"; then printf '  ok    %s\n' "$1"; else printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); fi
}

cleanup() {
  podman rm -f "$P" "$P-api-agent" >/dev/null 2>&1 || true
  podman network rm -f "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
[[ -n $OPENBAO_IMAGE ]] || { echo "no OpenBao image in compose.yaml" >&2; exit 1; }

# The server as in production, but over plain HTTP on the test network: TLS
# is the certs job's business, not the procedure's.
config='storage "raft" {
  path    = "/openbao/data"
  node_id = "test"
}
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
api_addr      = "http://openbao-test:8200"
cluster_addr  = "http://openbao-test:8201"'
podman network create "$NET" >/dev/null
podman run -d --name "$P" --network "$NET" -e BAO_ADDR=http://127.0.0.1:8200 --entrypoint sh "$OPENBAO_IMAGE" \
  -c "mkdir -p /openbao/data && printf '%s' '$config' > /tmp/server.hcl && exec bao server -config=/tmp/server.hcl" >/dev/null
# Stands in for api-agent: the same image, with the tmpfs the credential goes to.
podman run -d --name "$P-api-agent" --network "$NET" -e BAO_ADDR=http://openbao-test:8200 \
  --tmpfs /run/agent --entrypoint sleep "$OPENBAO_IMAGE" infinity >/dev/null

# A stored value, read as alice; empty when absent.
kv() { # <service> <key>
  local token
  token=$(printf 'alice-password-0001' | podman exec -i "$P" bao write -field=token auth/userpass/login/alice password=-)
  printf '%s\n' "$token" | podman exec -i "$P" sh -c \
    'IFS= read -r BAO_TOKEN; export BAO_TOKEN; bao kv get -format=json "kv/$1" 2>/dev/null || echo "{}"' sh "$1" |
    jq -r --arg k "$2" '.data.data[$k] // empty'
}
missing() { printf 'alice-password-0001\n' | "${BAO[@]}" missing --admin alice 2>&1; }
status() { podman exec "$P" bao status -format=json 2>/dev/null | jq -r ".$1"; }
secret_id() { podman exec "$P-api-agent" cat /run/agent/secret_id 2>/dev/null || true; }

echo "openbao-test: init"
check "a short password is refused" \
  bash -c "! printf 'short\nshort\n' | $(printf '%q ' "${BAO[@]}") init --admin alice >/dev/null 2>&1"
check "OpenBao is still uninitialised after that" test "$(status initialized)" = false

log_file=$(mktemp)
key=$(printf 'alice-password-0001\nalice-password-0001\n' | "${BAO[@]}" init --admin alice 2>"$log_file") || {
  cat "$log_file" >&2; rm -f "$log_file"; exit 1
}
init_log=$(cat "$log_file"); rm -f "$log_file"
check "init prints exactly one unseal key on stdout" test "$(wc -l <<<"$key")" = 1
check "one share, threshold one" test "$(status n)/$(status t)" = 1/1
check "unsealed after init" test "$(status sealed)" = false
check "init reports the root token revoked" grep -q 'root token revoked' <<<"$init_log"
first_id=$(secret_id)
check "the running agent got a secret_id" test -n "$first_id"
check "init refuses a second time" bash -c "! $(printf '%q ' "${BAO[@]}") init --admin alice </dev/null >/dev/null 2>&1"

echo "openbao-test: values"
m=$(missing)
check "internal values are generated" bash -c "! grep -qE 'api:(auth_signing_secret|database_password|saml_sp_key)' <<<'$m'"
check "external values are listed as missing" bash -c "grep -q 'api:ldap_bind_password' <<<'$m' && grep -q 'api:saml_idp_cert' <<<'$m' && grep -q 'grafana:smtp_password' <<<'$m'"
check "values can be read back (the checks below mean something)" test -n "$(kv api database_password)"
check "local-only services get nothing" test -z "$(kv ldap admin_password)$(kv idp admin_password)$(kv test database_password)"
check "local-only values are neither generated nor missing" bash -c "[[ -z '$(kv s3 test_key_id)' ]] && ! grep -q 's3:test_' <<<'$m'"
check "Garage's values have its formats" bash -c "[[ '$(kv s3 rpc_secret)' =~ ^[0-9a-f]{64}$ && '$(kv s3 api_key_id)' =~ ^GK[0-9a-f]{24}$ ]]"
check "the api's S3 key is the one s3 imports" test "$(kv api s3_key_id)" = "$(kv s3 api_key_id)"
check "services that share a value agree on it" test "$(kv api database_password)" = "$(kv pgbouncer app_password)"
check "... and the database has it too" test "$(kv api database_password)" = "$(kv postgres app_password)"
check "the SP key pair is a key and a certificate" bash -c "[[ '$(kv api saml_sp_key | head -1)' == '-----BEGIN PRIVATE KEY-----' && '$(kv api saml_sp_cert | head -1)' == '-----BEGIN CERTIFICATE-----' ]]"
printf 'alice-password-0001\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' |
  "${BAO[@]}" set api saml_idp_cert --admin alice >/dev/null 2>&1
check "set writes an external value, as given" test "$(kv api saml_idp_cert)" = "$(printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----')"
check "set refuses a key no agent renders" \
  bash -c "! printf 'alice-password-0001\nx\n' | $(printf '%q ' "${BAO[@]}") set api no_such_key --admin alice >/dev/null 2>&1"
check "a wrong administrator password is refused" \
  bash -c "! printf 'wrong-password-000\n' | $(printf '%q ' "${BAO[@]}") missing --admin alice >/dev/null 2>&1"

echo "openbao-test: administrators"
printf 'alice-password-0001\nbob-password-000001\nbob-password-000001\n' | "${BAO[@]}" add-admin bob --admin alice >/dev/null 2>&1
check "a second administrator can log in" bash -c "printf 'bob-password-000001\n' | $(printf '%q ' "${BAO[@]}") missing --admin bob >/dev/null 2>&1"

echo "openbao-test: restart"
podman restart "$P" >/dev/null
for _ in $(seq 30); do [[ $(status sealed) == true ]] && break; sleep 1; done
check "sealed after a restart" test "$(status sealed)" = true
check "a wrong key leaves it sealed" \
  bash -c "! printf 'd3Jvbmc=\nalice-password-0001\n' | $(printf '%q ' "${BAO[@]}") unseal --admin alice >/dev/null 2>&1"
printf '%s\nalice-password-0001\n' "$key" | "${BAO[@]}" unseal --admin alice >/dev/null 2>&1
check "unseal with the key and an admin login" test "$(status sealed)" = false
check "unseal re-issued the agent's secret_id" bash -c "[[ -n '$(secret_id)' && '$(secret_id)' != '$first_id' ]]"

((failures == 0)) || { echo "openbao-test: $failures failed" >&2; exit 1; }
echo "openbao-test: all passed"
