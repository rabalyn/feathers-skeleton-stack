#!/usr/bin/env bash
# gitleaks in a container (ADR 0023), for the pre-commit hook and the CI gate.
#
#   scripts/gitleaks.sh           the whole history (CI gate)
#   scripts/gitleaks.sh --staged  what is about to be committed (pre-commit)
#
# The work tree and the common git dir are mounted at their host paths, so a
# linked worktree (whose .git is a file naming an absolute path under the
# common dir) resolves inside the container as it does outside. The scan fails
# when git cannot read the repository or gitleaks logs an error: gitleaks
# itself logs git failures and still exits 0 with "no leaks found".
set -euo pipefail

GITLEAKS=docker.io/zricethezav/gitleaks@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb # v8.30.1

case ${1:-} in
  "") args=() ;;
  --staged) args=(--pre-commit --staged) ;;
  *) echo "usage: $0 [--staged]" >&2; exit 2 ;;
esac

top=$(git rev-parse --show-toplevel)
common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)

exec podman run --rm --network none \
  -v "$top:$top:ro,Z" -v "$common:$common:ro,Z" -w "$top" \
  --entrypoint /bin/sh "$GITLEAKS" -c '
    set -eu
    git rev-parse --git-dir >/dev/null && git ls-files --stage >/dev/null || {
      echo "gitleaks: git cannot read the repository in the container; not scanning" >&2
      exit 1
    }
    log=$(mktemp)
    status=0
    gitleaks git "$@" --redact --no-banner --no-color . >"$log" 2>&1 || status=$?
    cat "$log" >&2
    if [ "$status" -eq 0 ] && grep -q " ERR " "$log"; then
      echo "gitleaks: reported an error; failing instead of trusting \"no leaks found\"" >&2
      exit 1
    fi
    exit "$status"
  ' sh "${args[@]}"
