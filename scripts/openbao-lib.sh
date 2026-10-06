# OpenBao access and configuration shared by scripts/stack.sh (local, CI)
# and scripts/openbao.sh (production), so the policies and secret paths are
# identical in every environment (ADR 0023). Sourced, never run; the caller
# defines log, die, OPENBAO_DIR and AGENTS, the agents of its environment.
#
# Everything goes through `podman exec` into the OpenBao container, so no
# script needs a network route or a local bao binary. Each exec costs a
# quarter of a second or more, so the loops over agents and values read and
# write OpenBao in bulk, one exec for all of them, rather than per value.

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

# A shell script run as TOKEN inside the OpenBao container, for the bulk
# calls; the token travels as for bao_as, the rest of stdin is the script's.
bao_script() { # <script> [<arg>...]
  local script=$1; shift
  { printf '%s\n' "$TOKEN"; cat; } | podman exec -i "$OPENBAO_CONTAINER" \
    sh -c 'IFS= read -r BAO_TOKEN; export BAO_TOKEN; '"$script" sh "$@"
}

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

  # Every agent's policy, AppRole and role id in one exec: a line per agent
  # with its name, role id and policy (base64, one line).
  local svc
  for svc in $AGENTS; do
    [[ -f $OPENBAO_DIR/policies/$svc.hcl ]] || die "missing policy for $svc"
    printf '%s %s %s\n' "$svc" "$(cat "$OPENBAO_DIR/agents/$svc.role_id")" "$(base64 -w0 <"$OPENBAO_DIR/policies/$svc.hcl")"
  done | bao_script '
    while read -r svc role_id policy; do
      printf "%s" "$policy" | base64 -d | bao policy write "$svc" - >/dev/null &&
        bao write "auth/approle/role/$svc" token_policies="$svc" \
          token_ttl=1h token_max_ttl=24h secret_id_num_uses=0 secret_id_ttl=0 >/dev/null &&
        bao write "auth/approle/role/$svc/role-id" role_id="$role_id" >/dev/null || exit 1
    done'
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

# Every listed service's values in one exec, as a JSON object of service to
# its map of key to value (null for a service without values). It holds the
# values themselves, so it is only ever passed on through pipes.
kv_dump() { # <service>...
  bao_script 'for svc; do printf "\"%s\"\n" "$svc"; bao kv get -format=json "kv/$svc" 2>/dev/null || echo null; done' "$@" </dev/null |
    jq -cs '. as $a | reduce range(0; $a | length; 2) as $i ({}; .[$a[$i]] = ($a[$i + 1].data.data // null))'
}

stored_value() { # <service> <key> ; kv_dump output on stdin
  jq -r --arg s "$1" --arg k "$2" '.[$s][$k] // empty'
}

# Writes many values in one exec: NUL-separated <service> <key> <value>
# triples on stdin; a service the dump has values for is patched, any other
# one created.
kv_write_all() { # <kv_dump output>
  local existing
  existing=$(printf '%s' "$1" | jq -r 'to_entries[] | select(.value != null) | .key' | tr '\n' ' ')
  jq -rRs --arg existing " $existing" '
    split("\u0000")[:-1] as $f
    | [range(0; $f | length; 3) as $i | {s: $f[$i], k: $f[$i + 1], v: $f[$i + 2]}]
    | group_by(.s)[]
    | .[0].s as $s
    | (if ($existing | contains(" " + $s + " ")) then "patch" else "put" end) + " " + $s,
      (map({(.k): .v}) | add | tojson)' |
    bao_script '
      while read -r verb svc && IFS= read -r data; do
        printf "%s" "$data" | bao kv "$verb" "kv/$svc" - >/dev/null || exit 1
      done'
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
  local mode=$1 name gen targets target wanted value svc key stored writes=()
  stored=$(kv_dump $AGENTS)
  while read -r name gen targets; do
    [[ -z $name || $name == \#* ]] && continue
    wanted=
    for target in $targets; do is_agent "${target%%:*}" && wanted+=" $target"; done
    [[ -n $wanted ]] || continue
    [[ $mode == production && ($gen == local || $gen == local-only:*) ]] && continue
    value=
    for target in $wanted; do
      value=$(printf '%s' "$stored" | stored_value "${target%%:*}" "${target#*:}")
      [[ -n $value ]] && break
    done
    [[ -n $value ]] || { log "generating $name"; value=$(generate "$gen"); }
    for target in $wanted; do
      svc=${target%%:*} key=${target#*:}
      [[ -n $(printf '%s' "$stored" | stored_value "$svc" "$key") ]] || writes+=("$svc" "$key" "$value")
    done
  done <"$OPENBAO_DIR/secrets.conf"
  ((${#writes[@]})) || return 0
  printf '%s\0' "${writes[@]}" | kv_write_all "$stored"
}

# Every <service>:<key> an agent in AGENTS renders but OpenBao does not hold,
# read from the agents' own templates. Targets of `local-only:` entries are
# not missing anywhere: their templates render nothing without them.
missing_keys() {
  local svc key local_only stored
  local_only=" $(awk '$2 ~ /^local-only:/ { for (i = 3; i <= NF; i++) printf "%s ", $i }' "$OPENBAO_DIR/secrets.conf")"
  stored=$(kv_dump $AGENTS)
  for svc in $AGENTS; do
    for key in $(grep -o '\.Data\.data\.[a-z0-9_]*' "$OPENBAO_DIR/agents/$svc.hcl" | sed 's/.*\.//' | sort -u); do
      [[ $local_only == *" $svc:$key "* ]] && continue
      [[ -n $(printf '%s' "$stored" | stored_value "$svc" "$key") ]] || echo "$svc:$key"
    done
  done
}

# --- agent credentials -------------------------------------------------------

# Destroys the previous secret_ids of every running agent in AGENTS, issues a
# new one response-wrapped, and unwraps it inside the agent container into
# the agent's own tmpfs. Every running agent, or only those named.
issue_secret_ids() { # [<service>...]
  local svc wrap running_agents=() wraps
  for svc in ${*:-$AGENTS}; do
    running "$AGENT_PREFIX$svc-agent" && running_agents+=("$svc")
  done
  ((${#running_agents[@]})) || return 0
  # Destroying the old secret_ids and wrapping the new ones for every agent
  # in one exec; a line per agent with its name and wrapping token.
  wraps=$(bao_script '
    for svc; do
      for accessor in $(bao list -format=json "auth/approle/role/$svc/secret-id" 2>/dev/null | tr -d "[]{}\", " | sed "/^$/d"); do
        bao write "auth/approle/role/$svc/secret-id-accessor/destroy" secret_id_accessor="$accessor" >/dev/null || exit 1
      done
      wrap=$(bao write -wrap-ttl=2m -field=wrapping_token -f "auth/approle/role/$svc/secret-id") || exit 1
      printf "%s %s\n" "$svc" "$wrap"
    done' "${running_agents[@]}" </dev/null)
  while read -r svc wrap; do
    printf '%s\n' "$wrap" | podman exec -i "$AGENT_PREFIX$svc-agent" sh -c '
      set -e; umask 077
      IFS= read -r BAO_TOKEN; export BAO_TOKEN
      bao unwrap -field=secret_id > /run/agent/secret_id.new
      mv /run/agent/secret_id.new /run/agent/secret_id'
    log "issued secret_id for $svc-agent"
  done < <(printf '%s\n' "$wraps")
}
