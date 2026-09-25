#!/usr/bin/env bash
# Generate the production Quadlet units from compose.yaml (ADR 0001).
#
#   scripts/quadlet.sh          regenerate deploy/quadlet/
#   scripts/quadlet.sh --check  fail if deploy/quadlet/ differs from a fresh run
#
# Only the generated *.container, *.network and *.volume files are managed
# here. Production settings live in drop-in directories next to them
# (<unit>.d/*.conf) and are never touched.
#
# Before podlet sees the file, YAML anchors are resolved and local-only
# parts are removed:
# - `build:` (podlet rejects it; production pulls built images),
# - services under the `local`, `test` and `dev` profiles (ADR 0001, 0002,
#   0014), and every depends_on entry that pointed at one of them,
# - environment values interpolated from the caller's environment (`${...}`),
#   which podlet would copy literally; they are local switches,
# - networks left with fewer than two members (idp-edge, once idp is gone),
#   whether a service lists its networks or maps them (for aliases),
#   and volumes no remaining service mounts.
# `condition: service_healthy` has no podlet translation; it becomes a plain
# dependency, and the service depended on gets `Notify=healthy`, which makes
# systemd consider it started only once its healthcheck passes.
# `condition: service_completed_successfully` (which podlet drops silently)
# likewise becomes a plain dependency on a `Type=oneshot` unit with
# `RemainAfterExit=yes`, which systemd considers started once it has exited
# successfully.
# After generation, bind-mount sources relative to the repository root are
# rewritten relative to deploy/quadlet/, which is how Quadlet resolves them.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/deploy/quadlet
YQ=docker.io/mikefarah/yq:4.53.6@sha256:127185429860d8240ba879fd96db7b33fe4895609864f0ab21b93e4d2ac20b5e
PODLET=ghcr.io/containers/podlet:v0.3.2@sha256:7c257b788818bc040fe3555e0507ff913df66620470d05a55fd8e59343064221
HEADER='# Generated from compose.yaml by scripts/quadlet.sh. Do not edit; put
# production settings in a drop-in directory next to this file.'

generate() { # <dir>
  local dir=$1 f svc
  mkdir -p "$dir/units"
  # To the YAML spec: a service's own keys win over those it merges in.
  podman run --rm -i --network none "$YQ" --yaml-fix-merge-anchor-to-spec=true '
    explode(.)
    | del(.services[].build)
    | del(.services[] | select((.profiles // []) | any_c(. == "local" or . == "test" or . == "dev")))
    | .services[] |= (select(has("environment")).environment |= with_entries(select(.value | tostring | test("\\$\\{") | not)))
    | (.services | keys) as $names
    | .services[] |= (
        select(has("depends_on")).depends_on |= with_entries(select(.key as $k | $names | any_c(. == $k)))
      )
    | del(.services[] | select(.depends_on == {}) | .depends_on)
    | ([.services[] | (.networks // []) | ((select(tag == "!!seq") | .[]), (select(tag == "!!map") | keys | .[]))]
        | group_by(.) | map(select(length < 2) | .[0])) as $lonely
    | .services[] |= (select(has("networks") and (.networks | tag == "!!seq")).networks |= map(select(. as $n | $lonely | any_c(. == $n) | not)))
    | .services[] |= (select(has("networks") and (.networks | tag == "!!map")).networks |= with_entries(select(.key as $n | $lonely | any_c(. == $n) | not)))
    | .networks |= with_entries(select(.key as $n | $lonely | any_c(. == $n) | not))
    | [.services[].volumes // [] | .[] | split(":") | .[0]] as $used
    | .volumes |= with_entries(select(.key as $v | $used | any_c(. == $v)))
  ' <"$ROOT/compose.yaml" >"$dir/stripped.yaml"
  podman run --rm -i --network none "$YQ" \
    '[.services[].depends_on // {} | to_entries[] | select(.value.condition == "service_healthy") | .key] | unique | .[]' \
    <"$dir/stripped.yaml" >"$dir/healthy.txt"
  podman run --rm -i --network none "$YQ" \
    '[.services[].depends_on // {} | to_entries[] | select(.value.condition == "service_completed_successfully") | .key] | unique | .[]' \
    <"$dir/stripped.yaml" >"$dir/oneshot.txt"
  podman run --rm -i --network none "$YQ" \
    '(.services[] | select(has("depends_on")) | .depends_on[] | select(.condition == "service_healthy" or .condition == "service_completed_successfully") | .condition) = "service_started"' \
    <"$dir/stripped.yaml" >"$dir/compose.yaml"
  podman run --rm --network none -v "$dir:/w:Z" -w /w "$PODLET" \
    --file units compose compose.yaml >/dev/null
  while read -r svc; do
    [[ -n $svc ]] && sed -i '/^\[Container\]$/a Notify=healthy' "$dir/units/$svc.container"
  done <"$dir/healthy.txt"
  while read -r svc; do
    [[ -n $svc ]] && printf '\n[Service]\nType=oneshot\nRemainAfterExit=yes\n' >>"$dir/units/$svc.container"
  done <"$dir/oneshot.txt"
  for f in "$dir"/units/*; do
    # A network mapped without options comes out as `name.network:`.
    sed -i -e 's#^Volume=\./#Volume=../../#' -e 's#^\(Network=[^:]*\):$#\1#' "$f"
    { printf '%s\n\n' "$HEADER"; cat "$f"; } >"$f.tmp" && mv "$f.tmp" "$f"
  done
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
generate "$tmp"

if [[ ${1:-} == --check ]]; then
  if ! diff -r -x '*.d' "$tmp/units" "$OUT"; then
    echo "deploy/quadlet/ is out of date; run scripts/quadlet.sh" >&2
    exit 1
  fi
  echo "deploy/quadlet/ is up to date"
  exit 0
fi

mkdir -p "$OUT"
find "$OUT" -maxdepth 1 -type f \( -name '*.container' -o -name '*.network' -o -name '*.volume' \) -delete
cp "$tmp"/units/* "$OUT"/
echo "wrote $(ls "$tmp/units" | wc -l) units to deploy/quadlet/"
