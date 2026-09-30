# OpenBao access and configuration shared by scripts/stack.sh (local, CI)
# and scripts/openbao.sh (production), so the policies and secret paths are
# identical in every environment (ADR 0023). Sourced, never run; the caller
# defines log, die, OPENBAO_DIR and AGENTS, the agents of its environment.
#
# Everything goes through `podman exec` into the OpenBao container, so no
# script needs a network route or a local bao binary.

OPENBAO_CONTAINER=${OPENBAO_CONTAINER:-openbao}
# Agent containers are named <service>-agent; a test puts its own in front.
AGENT_PREFIX=${AGENT_PREFIX:-}

running() { [[ $(podman container inspect -f '{{.State.Running}}' "$1" 2>/dev/null) == true ]]; }

is_agent() { [[ " $AGENTS " == *" $1 "* ]]; }

# --- access ------------------------------------------------------------------

# Unauthenticated call inside the OpenBao container.
bao_plain() { podman exec -i "$OPENBAO_CONTAINER" bao "$@"; }

# Authenticated call as <token>. The token travels on stdin's first line,
# never in argv or the environment of a host process; the rest of stdin goes
# to bao.
bao_as() {
  local token=$1; shift
  { printf '%s\n' "$token"; cat; } | podman exec -i "$OPENBAO_CONTAINER" \
    sh -c 'IFS= read -r BAO_TOKEN; export BAO_TOKEN; exec bao "$@"' sh "$@"
}

# TOKEN is the token of one run (root, or an administrator's login), revoked
# at its end.
TOKEN=
bao_auth() { bao_as "$TOKEN" "$@"; }
bao() { bao_auth "$@" </dev/null; }

wait_for_openbao() {
  local i rc
  for i in $(seq 60); do
    rc=0; bao_plain status </dev/null >/dev/null 2>&1 || rc=$?
    # 0 = unsealed, 2 = sealed; both mean the listener answers.
    [[ $rc == 0 || $rc == 2 ]] && return 0
    sleep 1
  done
  die "OpenBao did not come up"
}

# `bao status` exits 2 while sealed; the JSON is what matters.
# `podman exec -i` reads stdin, which here belongs to the caller's prompts.
status_field() { { bao_plain status -format=json </dev/null 2>/dev/null || true; } | jq -r ".$1"; }

# Unseals with one key share read from stdin, so it is never an argument.
unseal_with() { # key share on stdin
  bao_plain write -format=json sys/unseal key=- >/dev/null
}

# --- configuration (idempotent) ----------------------------------------------

configure() {
  bao secrets list -format=json | jq -e '."kv/"' >/dev/null ||
    bao secrets enable -path=kv kv-v2 >/dev/null
  bao auth list -format=json | jq -e '."approle/"' >/dev/null ||
    bao auth enable approle >/dev/null
  bao_auth policy write admin - <"$OPENBAO_DIR/admin.hcl" >/dev/null

  local svc
  for svc in $AGENTS; do
    [[ -f $OPENBAO_DIR/policies/$svc.hcl ]] || die "missing policy for $svc"
    bao_auth policy write "$svc" - <"$OPENBAO_DIR/policies/$svc.hcl" >/dev/null
    bao write "auth/approle/role/$svc" token_policies="$svc" \
      token_ttl=1h token_max_ttl=24h secret_id_num_uses=0 secret_id_ttl=0 >/dev/null
    bao write "auth/approle/role/$svc/role-id" role_id="$(cat "$OPENBAO_DIR/agents/$svc.role_id")" >/dev/null
  done
}

# --- secret values -----------------------------------------------------------

generate() { # <generator>
  case ${1#local-only:} in
    random | local) head -c 36 /dev/urandom | base64 | tr '+/' '-_' ;;
    random-long) head -c 72 /dev/urandom | base64 -w0 | tr '+/' '-_' ;;
    hex32) od -An -vtx1 -N32 /dev/urandom | tr -d ' \n' ;;
    garage-key-id) printf 'GK%s' "$(od -An -vtx1 -N12 /dev/urandom | tr -d ' \n')" ;;
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

# Fills every missing value of secrets.conf for the agents in AGENTS; values
# that exist are never regenerated. In production, entries whose generator is
# `local` are supplied by an administrator instead (see missing_keys), and
# `local-only` entries do not exist at all.
fill_secrets() { # <local|production>
  local mode=$1 name gen targets target wanted value svc key
  while read -r name gen targets; do
    [[ -z $name || $name == \#* ]] && continue
    wanted=
    for target in $targets; do is_agent "${target%%:*}" && wanted+=" $target"; done
    [[ -n $wanted ]] || continue
    [[ $mode == production && ($gen == local || $gen == local-only:*) ]] && continue
    value=
    for target in $wanted; do
      value=$(kv_get "${target%%:*}" "${target#*:}")
      [[ -n $value ]] && break
    done
    [[ -n $value ]] || { log "generating $name"; value=$(generate "$gen"); }
    for target in $wanted; do
      svc=${target%%:*} key=${target#*:}
      [[ -n $(kv_get "$svc" "$key") ]] || printf '%s' "$value" | kv_set "$svc" "$key"
    done
  done <"$OPENBAO_DIR/secrets.conf"
}

# Every <service>:<key> an agent in AGENTS renders but OpenBao does not hold,
# read from the agents' own templates. Targets of `local-only:` entries are
# not missing anywhere: their templates render nothing without them.
missing_keys() {
  local svc key local_only
  local_only=" $(awk '$2 ~ /^local-only:/ { for (i = 3; i <= NF; i++) printf "%s ", $i }' "$OPENBAO_DIR/secrets.conf")"
  for svc in $AGENTS; do
    for key in $(grep -o '\.Data\.data\.[a-z_]*' "$OPENBAO_DIR/agents/$svc.hcl" | sed 's/.*\.//' | sort -u); do
      [[ $local_only == *" $svc:$key "* ]] && continue
      [[ -n $(kv_get "$svc" "$key") ]] || echo "$svc:$key"
    done
  done
}

# --- agent credentials -------------------------------------------------------

# Destroys the previous secret_ids of every running agent in AGENTS, issues a
# new one response-wrapped, and unwraps it inside the agent container into
# the agent's own tmpfs. Every running agent, or only those named.
issue_secret_ids() { # [<service>...]
  local svc accessor wrap
  for svc in ${*:-$AGENTS}; do
    running "$AGENT_PREFIX$svc-agent" || continue
    for accessor in $({ bao list -format=json "auth/approle/role/$svc/secret-id" 2>/dev/null || echo '[]'; } | jq -r '.[]'); do
      bao write "auth/approle/role/$svc/secret-id-accessor/destroy" secret_id_accessor="$accessor" >/dev/null
    done
    wrap=$(bao write -wrap-ttl=2m -field=wrapping_token -f "auth/approle/role/$svc/secret-id")
    printf '%s\n' "$wrap" | podman exec -i "$AGENT_PREFIX$svc-agent" sh -c '
      set -e; umask 077
      IFS= read -r BAO_TOKEN; export BAO_TOKEN
      bao unwrap -field=secret_id > /run/agent/secret_id.new
      mv /run/agent/secret_id.new /run/agent/secret_id'
    log "issued secret_id for $svc-agent"
  done
}
