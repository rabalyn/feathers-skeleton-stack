#!/usr/bin/env bash
# The declared versions of what production runs (ADR 0032).
#
#   scripts/inventory.sh          regenerate apps/api/src/system/inventory.ts
#   scripts/inventory.sh --check  fail if it differs from a fresh run
#
# scripts/inventory.mjs reads compose.yaml, the Containerfiles and
# deploy/quadlet/; it runs in the pinned Node image without a network, so
# the host needs only Podman. Run it after changing an image pin, or after
# scripts/quadlet.sh.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/apps/api/src/system/inventory.ts
# One Node pin for the scripts: stack.sh's.
NODE_IMAGE=$(sed -n 's/^NODE_IMAGE=//p' "$ROOT/scripts/stack.sh")
[[ -n $NODE_IMAGE ]] || { echo "inventory: no NODE_IMAGE in scripts/stack.sh" >&2; exit 1; }

generate() {
  podman run --rm --network none --security-opt label=disable -v "$ROOT:/repo:ro" -w /repo \
    "$NODE_IMAGE" node scripts/inventory.mjs /repo
}

case "${1:-}" in
  --check)
    fresh=$(generate)
    if ! diff -u "$OUT" <(printf '%s\n' "$fresh"); then
      echo "inventory: $OUT is out of date; run scripts/inventory.sh" >&2
      exit 1
    fi
    ;;
  '')
    fresh=$(generate)
    mkdir -p "$(dirname "$OUT")"
    printf '%s\n' "$fresh" >"$OUT"
    echo "wrote $OUT"
    ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac
