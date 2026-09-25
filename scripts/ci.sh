#!/usr/bin/env bash
# The CI gate, runnable on any machine with rootless Podman (ADR 0015, 0018,
# 0023). A hosted pipeline runs `scripts/ci.sh --cold`.
#
#   scripts/ci.sh           static checks, then the stack checks against the
#                           current stack (`up` rebuilds and recreates)
#   scripts/ci.sh --cold    reset the stack first, as a fresh runner would
#   scripts/ci.sh --static  static checks only: no stack, no image scan
#
# Static: gitleaks over the whole history, ESLint, the client dependency
# boundary, typecheck, unit tests that need no stack, pnpm audit, the Quadlet
# drift check.
# Stack: up, Vitest, Playwright, then the vulnerability scan of every image
# compose.yaml names.
#
# Blocking thresholds (ADR 0018): pnpm audit at high and above; Trivy on
# HIGH/CRITICAL findings that have a fix. Unfixed findings are reported
# without blocking. Accepted findings go in .trivyignore.yaml, each with a
# statement and an expiry date after which it blocks again.
#
# One file is not scanned: gosu in the PostgreSQL image, a static Go binary
# that only drops root privileges at container start. Its Go standard library
# findings concern code it never runs (TLS, HTTP, parsers), which is the
# upstream image's documented position; the binary is replaced with the
# image, not patched.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
GITLEAKS=docker.io/zricethezav/gitleaks@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb # v8.30.1
TRIVY=docker.io/aquasec/trivy@sha256:ee940acbf1f58ebadb42d01434ce4609530bf1b52536afbd1eee66cd7123c5c9 # 0.74.0
YQ=docker.io/mikefarah/yq:4.53.6@sha256:127185429860d8240ba879fd96db7b33fe4895609864f0ab21b93e4d2ac20b5e
CI_IMAGE=localhost/feathers-ci:dev
TRIVY_CACHE=feathers-trivy-cache

mode=${1:-}
case $mode in "" | --cold | --static) ;; *) echo "usage: $0 [--cold|--static]" >&2; exit 2 ;; esac

step() { printf '\n\033[1mci: %s\033[0m\n' "$*" >&2; }
failed=()
check() { # <name> <command...>: runs every check, fails at the end
  local name=$1; shift
  step "$name"
  if "$@"; then return 0; fi
  failed+=("$name")
}

in_ci_image() { podman run --rm "$CI_IMAGE" "$@"; }

gitleaks() {
  podman run --rm --network none -v "$ROOT:/repo:ro,Z" "$GITLEAKS" \
    git /repo --redact --no-banner
}

scan_images() {
  local images image rc=0 dir
  images=$(podman run --rm -i --network none "$YQ" '.services[].image' <"$ROOT/compose.yaml" | sed 's/ *#.*//' | sort -u)
  podman volume exists "$TRIVY_CACHE" || podman volume create "$TRIVY_CACHE" >/dev/null
  dir=$(mktemp -d "${TMPDIR:-/tmp}/ci-scan.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$dir'" RETURN
  for image in $images; do
    step "scan $image"
    podman image exists "$image" || podman pull -q "$image" >/dev/null
    podman save -q -o "$dir/image.tar" "$image"
    podman run --rm -v "$TRIVY_CACHE:/root/.cache/trivy" -v "$dir:/scan:ro,Z" \
      -v "$ROOT/.trivyignore.yaml:/scan-ignore.yaml:ro,Z" "$TRIVY" image --quiet \
      --input /scan/image.tar --scanners vuln --ignorefile /scan-ignore.yaml \
      --skip-files usr/local/bin/gosu \
      --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 || rc=1
    rm -f "$dir/image.tar"
  done
  return $rc
}

# --- static --------------------------------------------------------------

check "gitleaks (whole history)" gitleaks
step "building the ci image"
podman build -q -t "$CI_IMAGE" -f "$ROOT/containers/ci/Containerfile" "$ROOT" >/dev/null
check "lint and client boundary" in_ci_image pnpm lint
check "typecheck" in_ci_image pnpm typecheck
check "unit tests" in_ci_image pnpm test:unit
check "pnpm audit (high and above)" in_ci_image pnpm audit --audit-level=high
check "Quadlet units match compose.yaml" "$ROOT/scripts/quadlet.sh" --check

# --- stack ---------------------------------------------------------------

if [[ $mode != --static ]]; then
  if [[ $mode == --cold ]]; then
    step "cold start: reset"
    "$ROOT/scripts/stack.sh" reset
  fi
  step "stack up"
  "$ROOT/scripts/stack.sh" up || { failed+=("stack up"); mode=--static; }
fi
if [[ $mode != --static ]]; then
  check "Vitest" "$ROOT/scripts/stack.sh" test
  check "Playwright" "$ROOT/scripts/stack.sh" e2e
  # The dev server image is never started here but ships to developers, so
  # it is built for the scan like every other image compose.yaml names.
  step "building the dev server image"
  (cd "$ROOT" && podman-compose --profile dev build web >/dev/null) || failed+=("dev server image build")
  check "image vulnerability scan" scan_images
fi

if ((${#failed[@]})); then
  printf '\n\033[1;31mci: failed:\033[0m\n' >&2
  printf '  - %s\n' "${failed[@]}" >&2
  exit 1
fi
printf '\n\033[1;32mci: all checks passed\033[0m\n' >&2
