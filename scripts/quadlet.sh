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
# Before podlet sees the file, local-only parts are removed:
# - `build:` (podlet rejects it; production pulls built images),
# - services under the `local` and `test` profiles (ADR 0001, 0002), and
#   every depends_on entry that pointed at one of them,
# - networks left with fewer than two members (idp-edge, once idp is gone).
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
  local dir=$1 f
  mkdir -p "$dir/units"
  podman run --rm -i --network none "$YQ" '
    del(.services[].build)
    | del(.services[] | select((.profiles // []) | any_c(. == "local" or . == "test")))
    | (.services | keys) as $names
    | .services[] |= (
        select(has("depends_on")).depends_on |= with_entries(select(.key as $k | $names | any_c(. == $k)))
      )
    | del(.services[] | select(.depends_on == {}) | .depends_on)
    | ([.services[].networks // [] | .[]] | group_by(.) | map(select(length < 2) | .[0])) as $lonely
    | .services[] |= (select(has("networks")).networks |= map(select(. as $n | $lonely | any_c(. == $n) | not)))
    | .networks |= with_entries(select(.key as $n | $lonely | any_c(. == $n) | not))
  ' <"$ROOT/compose.yaml" >"$dir/compose.yaml"
  podman run --rm --network none -v "$dir:/w:Z" -w /w "$PODLET" \
    --file units compose compose.yaml >/dev/null
  for f in "$dir"/units/*; do
    sed -i -e 's#^Volume=\./#Volume=../../#' "$f"
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
