#!/usr/bin/env bash
# The CI gate, runnable on any machine with rootless Podman (ADR 0015, 0018,
# 0023). A hosted pipeline runs `scripts/ci.sh --cold`.
#
#   scripts/ci.sh           static checks, then the stack checks against the
#                           current stack (`up` rebuilds and recreates)
#   scripts/ci.sh --cold    reset the stack first, as a fresh runner would,
#                           but keep the local app's database and OpenBao
#   scripts/ci.sh --static  static checks only: no stack, no image scan
#
# Static: gitleaks over the whole history, ESLint, the client dependency
# boundary, typecheck, unit tests that need no stack, the service generator's
# drift check (ADR 0030), pnpm audit, the Quadlet and inventory drift checks
# (ADR 0032), the topology diagram's drift check (ADR 0019), the
# production OpenBao procedure against a throwaway OpenBao.
# Stack: up, Vitest, Playwright, the alert delivery check, the backup and
# restore cycle (scripts/backup-test.sh), then the vulnerability scan of
# every image compose.yaml names.
# Last, in every mode: scripts/prune.sh removes this project's stale images
# and fails on anonymous volume leaks.
#
# Every step's header carries the time it started, and the run ends with a
# table of how long each step took, longest first, to show where it goes.
#
# The backup target is a named volume unless BACKUP_TARGET names a host
# directory; scripts/ci-nfs-runner.sh runs this script with it on real NFS,
# as a runner does (ADR 0017).
#
# Blocking thresholds (ADR 0018): pnpm audit at high and above; Trivy on
# HIGH/CRITICAL findings that have a fix. Unfixed findings are reported
# without blocking. Accepted findings go in .trivyignore.yaml, each with a
# statement and an expiry date after which it blocks again; pnpm audit
# advisories with no fixed version go in auditConfig.ignoreGhsas in
# pnpm-workspace.yaml the same way.
#
# One file is not scanned: gosu in the PostgreSQL image, a static Go binary
# that only drops root privileges at container start. Its Go standard library
# findings concern code it never runs (TLS, HTTP, parsers), which is the
# upstream image's documented position; the binary is replaced with the
# image, not patched.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/product.sh
source "$ROOT/scripts/product.sh"
TRIVY=docker.io/aquasec/trivy@sha256:9db099105405c648166e6b94155eb32f8da12673cf1f455207f7385cc9a77283 # 0.75.0
YQ=docker.io/mikefarah/yq:4.54.1@sha256:2d6a23c682c574ae49320fdf2419441b6f10658588d44b6d8739d673b96903e5
CI_IMAGE=localhost/$PRODUCT-ci:dev
TRIVY_CACHE=$PRODUCT-trivy-cache

mode=${1:-}
case $mode in "" | --cold | --static) ;; *) echo "usage: $0 [--cold|--static]" >&2; exit 2 ;; esac

# A step lasts until the next one starts, or the run ends.
timings=() current= started=$SECONDS
duration() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }
end_step() {
  [[ -n $current ]] && timings+=("$((SECONDS - started))"$'\t'"$current")
  current=
}
step() {
  end_step
  current=$* started=$SECONDS
  printf '\n\033[1mci: %s %s\033[0m\n' "$(date +%T)" "$*" >&2
}
report_timings() {
  end_step
  ((${#timings[@]})) || return 0
  printf '\n\033[1mci: timings, %s in all\033[0m\n' "$(duration $SECONDS)" >&2
  local seconds name
  printf '%s\n' "${timings[@]}" | sort -t $'\t' -k1,1nr | while IFS=$'\t' read -r seconds name; do
    printf '  %8s  %s\n' "$(duration "$seconds")" "$name"
  done >&2
  timings=()
}
# Also when a step that is not a check stops the run.
trap report_timings EXIT
failed=()
check() { # <name> <command...>: runs every check, fails at the end
  local name=$1; shift
  step "$name"
  if "$@"; then return 0; fi
  failed+=("$name")
}

in_ci_image() { podman run --rm "$CI_IMAGE" "$@"; }

gitleaks() { (cd "$ROOT" && scripts/gitleaks.sh); }

# Every GHSA pnpm audit ignores (auditConfig.ignoreGhsas) carries a
# `# until YYYY-MM-DD:` comment; past that date it blocks again (ADR 0018).
audit_ignores_current() {
  local today; today=$(date +%F)
  awk -v today="$today" '
    /^[[:space:]]*- GHSA-/ {
      if (match($0, /# until [0-9]{4}-[0-9]{2}-[0-9]{2}:/)) {
        until = substr($0, RSTART + 8, 10)
        if (until < today) { print "expired " until ": " $2; bad = 1 }
      } else { print "no expiry: " $2; bad = 1 }
    }
    END { exit bad }' "$ROOT/pnpm-workspace.yaml"
}

scan_images() {
  local images image rc=0 dir
  images=$(podman run --rm -i --network none "$YQ" '.services[].image' <"$ROOT/compose.yaml" |
    sed -e 's/ *#.*//' -e "s/\${PRODUCT:?}/$PRODUCT/" | sort -u)
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
check "service generator output typechecks" in_ci_image pnpm --filter @app/api gen:check
check "pnpm audit (high and above)" in_ci_image pnpm audit --audit-level=high
check "pnpm audit ignores have not expired" audit_ignores_current
check "Quadlet units match compose.yaml" "$ROOT/scripts/quadlet.sh" --check
check "inventory matches the image pins" "$ROOT/scripts/inventory.sh" --check
check "topology diagram matches compose.yaml" "$ROOT/scripts/diagrams.sh"
check "production OpenBao procedure" "$ROOT/scripts/openbao-test.sh"

# --- stack ---------------------------------------------------------------

if [[ $mode != --static ]]; then
  if [[ $mode == --cold ]]; then
    # The local app's database and OpenBao survive (ADR 0015); on a fresh
    # runner there is nothing to keep, so it is a full cold start there.
    step "cold start: reset (keeping the local app's data)"
    "$ROOT/scripts/stack.sh" reset --keep-data
  fi
  step "stack up"
  "$ROOT/scripts/stack.sh" up || { failed+=("stack up"); mode=--static; }
fi
if [[ $mode != --static ]]; then
  check "Vitest" "$ROOT/scripts/stack.sh" test
  check "Playwright" "$ROOT/scripts/stack.sh" e2e
  check "MCP servers" "$ROOT/scripts/stack.sh" mcp
  check "Alert delivery" "$ROOT/scripts/stack.sh" alerts
  check "Backup and restore" "$ROOT/scripts/backup-test.sh"
  # The dev server image is never started here but ships to developers, so
  # it is built for the scan like every other image compose.yaml names.
  step "building the dev server image"
  (cd "$ROOT" && podman-compose --profile dev build web >/dev/null) || failed+=("dev server image build")
  check "image vulnerability scan" scan_images
fi
check "stale images and anonymous volumes" "$ROOT/scripts/prune.sh"
report_timings

if ((${#failed[@]})); then
  printf '\n\033[1;31mci: failed:\033[0m\n' >&2
  printf '  - %s\n' "${failed[@]}" >&2
  exit 1
fi
printf '\n\033[1;32mci: all checks passed\033[0m\n' >&2
