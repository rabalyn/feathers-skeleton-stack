#!/usr/bin/env bash
# Production OpenBao administration (ADR 0023), run by an administrator on
# the production host, next to the Quadlet units. Local and CI setup is
# scripts/stack.sh; both share scripts/openbao-lib.sh, so configuration,
# policies and secret paths are the same.
#
#   scripts/openbao.sh init --admin <name>
#       once, on a fresh OpenBao: initialise with one unseal key share,
#       unseal, configure, create the first administrator's account,
#       generate every value the stack only shares with itself, issue the
#       running agents' secret_ids, list the values still missing, and
#       revoke the root token. Prints the unseal key once, for KeePass.
#   scripts/openbao.sh unseal [--admin <name>]
#       after every start of the host or the openbao container: unseal
#       with the key share, then re-issue every running agent's secret_id
#   scripts/openbao.sh reissue [--admin <name>]
#       re-issue the secret_ids only, e.g. after an agent restarted
#   scripts/openbao.sh set <service> <key> [--admin <name>]
#       write one value, read from stdin: a value that comes from outside,
#       such as the university IdP's certificate or LDAP service password
#   scripts/openbao.sh missing [--admin <name>]
#       list the values agents render but OpenBao does not hold
#   scripts/openbao.sh add-admin <name> [--admin <name>]
#       another administrator's personal account
#
# Key shares and passwords are read from the terminal, never from arguments
# or the environment; without a terminal (tests) they are read from stdin,
# one per line. Every run revokes the token it worked with.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OPENBAO_DIR=$ROOT/containers/openbao
QUADLET_DIR=${QUADLET_DIR:-$ROOT/deploy/quadlet}

log() { printf '\033[1mopenbao:\033[0m %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

# The agents that run in production: those with a Quadlet unit.
AGENTS=$(for f in "$QUADLET_DIR"/*-agent.container; do basename "$f" -agent.container; done | tr '\n' ' ')
# shellcheck source=scripts/openbao-lib.sh
source "$ROOT/scripts/openbao-lib.sh"

# The terminal when there is one, stdin otherwise.
if { exec 3</dev/tty; } 2>/dev/null; then TTY=true; else exec 3<&0; TTY=false; fi

prompt_secret() { # <label>; the answer on stdout
  local answer
  [[ $TTY == true ]] && printf '%s: ' "$1" >/dev/tty
  IFS= read -rs answer <&3 || true
  [[ $TTY == true ]] && printf '\n' >/dev/tty
  printf '%s' "$answer"
}

prompt_line() { # <label>
  local answer
  [[ $TTY == true ]] && printf '%s: ' "$1" >/dev/tty
  IFS= read -r answer <&3 || true
  printf '%s' "$answer"
}

# Whatever token this run holds is revoked when it ends, however it ends.
revoke_token() { [[ -z $TOKEN ]] || bao token revoke -self >/dev/null 2>&1 || true; TOKEN=; }
trap revoke_token EXIT

MIN_PASSWORD=16
VALID_NAME='^[a-z][a-z0-9._-]{1,63}$'

new_password() { # <name>; a confirmed password on stdout
  local first second
  first=$(prompt_secret "new OpenBao password for $1 (at least $MIN_PASSWORD characters)")
  second=$(prompt_secret "repeat it")
  [[ $first == "$second" ]] || die "the passwords differ"
  (( ${#first} >= MIN_PASSWORD )) || die "the password is shorter than $MIN_PASSWORD characters"
  printf '%s' "$first"
}

login() { # <name>: TOKEN becomes that administrator's token
  local name=$1 password
  [[ -n $name ]] || name=$(prompt_line "OpenBao administrator")
  [[ $name =~ $VALID_NAME ]] || die "not an administrator name: $name"
  password=$(prompt_secret "OpenBao password for $name")
  TOKEN=$(printf '%s' "$password" | bao_plain write -field=token "auth/userpass/login/$name" password=- 2>/dev/null) ||
    die "login as $name failed"
}

require_unsealed() {
  [[ $(status_field initialized) == true ]] || die "OpenBao is not initialised; run: $0 init --admin <name>"
  [[ $(status_field sealed) == false ]] || die "OpenBao is sealed; run: $0 unseal"
}

report_missing() {
  local missing
  missing=$(missing_keys)
  if [[ -z $missing ]]; then
    log "every value the agents render is present"
    return 0
  fi
  log "values an administrator still has to write, e.g. $0 set api saml_idp_cert < idp.pem:"
  printf '  %s\n' $missing >&2
}

# The SAML SP key pair (ADR 0008), generated on this host; only OpenBao keeps it.
ensure_sp_keypair() {
  [[ -n $(kv_get api saml_sp_key) ]] && return 0
  command -v openssl >/dev/null || die "openssl is required to generate the SAML SP key pair"
  log "generating the SAML SP key pair"
  local pems key cert name
  # The display name only (ADR 0035): product.sh would also bring the local
  # stack's container prefix, which production does not have.
  name=$(set -a; source "$ROOT/product.env"; printf '%s' "$PRODUCT_DISPLAY_NAME")
  pems=$(openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=$name SP" \
    -keyout /dev/stdout -out /dev/stdout 2>/dev/null)
  key=$(sed -n '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/p' <<<"$pems")
  cert=$(sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' <<<"$pems")
  [[ -n $key && -n $cert ]] || die "SP key generation failed"
  printf '%s\n' "$key" | kv_set api saml_sp_key
  printf '%s\n' "$cert" | kv_set api saml_sp_cert
}

cmd_init() {
  local admin=$1 init key password
  [[ $admin =~ $VALID_NAME ]] || die "usage: $0 init --admin <name>"
  wait_for_openbao
  [[ $(status_field initialized) == false ]] || die "OpenBao is initialised already; after a restart run: $0 unseal"
  password=$(new_password "$admin")

  log "initialising OpenBao with one unseal key share"
  init=$(bao_plain operator init -key-shares=1 -key-threshold=1 -format=json </dev/null)
  key=$(jq -r '.unseal_keys_b64[0]' <<<"$init")
  TOKEN=$(jq -r '.root_token' <<<"$init")
  # First, before anything else can fail: without it the data is lost.
  log "the unseal key follows, once. Store it in KeePass and in the offline copy now:"
  printf '%s\n' "$key"

  printf '%s' "$key" | unseal_with
  [[ $(status_field sealed) == false ]] || die "unsealing failed"

  configure
  bao auth list -format=json | jq -e '."userpass/"' >/dev/null || bao auth enable userpass >/dev/null
  printf '%s' "$password" | bao_auth write "auth/userpass/users/$admin" password=- token_policies=admin \
    token_ttl=1h token_max_ttl=8h >/dev/null
  log "created the administrator account $admin"

  fill_secrets production
  ensure_sp_keypair
  issue_secret_ids
  report_missing
  revoke_token
  log "root token revoked; from now on log in as $admin"
}

cmd_unseal() {
  wait_for_openbao
  [[ $(status_field initialized) == true ]] || die "OpenBao is not initialised; run: $0 init --admin <name>"
  if [[ $(status_field sealed) == true ]]; then
    prompt_secret "unseal key" | unseal_with
    [[ $(status_field sealed) == false ]] || die "OpenBao is still sealed: wrong key?"
    log "unsealed"
  else
    log "OpenBao is unsealed already"
  fi
  login "$1"
  issue_secret_ids
  report_missing
}

cmd_reissue() {
  wait_for_openbao
  require_unsealed
  login "$1"
  issue_secret_ids
}

cmd_set() { # <service> <key> <admin>
  local svc=$1 key=$2 value
  is_agent "$svc" || die "no production agent renders secrets for $svc"
  grep -q "\.Data\.data\.$key " "$OPENBAO_DIR/agents/$svc.hcl" ||
    die "the $svc agent renders no $key"
  wait_for_openbao
  require_unsealed
  login "$3"
  # A terminal gets one hidden line; a pipe may carry a whole PEM file.
  if [[ -t 0 ]]; then value=$(prompt_secret "value of $svc:$key"); else value=$(cat); fi
  [[ -n $value ]] || die "empty value; nothing written"
  printf '%s' "$value" | kv_set "$svc" "$key"
  log "wrote $svc:$key; its agent renders it within a minute"
}

cmd_missing() {
  wait_for_openbao
  require_unsealed
  login "$1"
  report_missing
}

cmd_add_admin() { # <name> <admin>
  local name=$1 password
  [[ $name =~ $VALID_NAME ]] || die "usage: $0 add-admin <name>"
  wait_for_openbao
  require_unsealed
  login "$2"
  password=$(new_password "$name")
  printf '%s' "$password" | bao_auth write "auth/userpass/users/$name" password=- token_policies=admin \
    token_ttl=1h token_max_ttl=8h >/dev/null
  log "created the administrator account $name"
}

command -v jq >/dev/null || die "jq is required"
cmd=${1:-}; shift || true
admin=
args=()
while (($#)); do
  case $1 in
    --admin) admin=${2:-}; shift 2 || die "--admin needs a name" ;;
    *) args+=("$1"); shift ;;
  esac
done

case $cmd in
  init) ((${#args[@]} == 0)) || die "usage: $0 init --admin <name>"; cmd_init "$admin" ;;
  unseal) cmd_unseal "$admin" ;;
  reissue) cmd_reissue "$admin" ;;
  set) ((${#args[@]} == 2)) || die "usage: $0 set <service> <key>"; cmd_set "${args[0]}" "${args[1]}" "$admin" ;;
  missing) cmd_missing "$admin" ;;
  add-admin) ((${#args[@]} == 1)) || die "usage: $0 add-admin <name>"; cmd_add_admin "${args[0]}" "$admin" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2; exit 2 ;;
esac
