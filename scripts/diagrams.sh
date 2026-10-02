#!/usr/bin/env bash
# Fails when the topology diagram page's network matrix or listener table
# no longer matches compose.yaml (ADR 0019, *Diagrams*).
#
#   scripts/diagrams.sh
#
# yq turns compose.yaml into JSON and scripts/diagrams.mjs compares it with
# docs/adr_v2/diagrams/topology.md; both run in pinned images without a
# network, so the host needs only Podman. A failure names each difference;
# fix the page, not the check.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
YQ=docker.io/mikefarah/yq:4.54.1@sha256:2d6a23c682c574ae49320fdf2419441b6f10658588d44b6d8739d673b96903e5
# One Node pin for the scripts: stack.sh's.
NODE_IMAGE=$(sed -n 's/^NODE_IMAGE=//p' "$ROOT/scripts/stack.sh")
[[ -n $NODE_IMAGE ]] || { echo "diagrams: no NODE_IMAGE in scripts/stack.sh" >&2; exit 1; }

podman run --rm -i --network none "$YQ" --yaml-fix-merge-anchor-to-spec=true -o=json 'explode(.)' <"$ROOT/compose.yaml" |
  podman run --rm -i --network none --security-opt label=disable -v "$ROOT:/repo:ro" -w /repo \
    "$NODE_IMAGE" node scripts/diagrams.mjs /repo
