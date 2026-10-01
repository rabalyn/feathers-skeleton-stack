#!/usr/bin/env bash
# Remove this project's stale images, and fail on anonymous volumes (ADR 0015).
#
#   scripts/prune.sh
#
# Runs at the end of `scripts/stack.sh up` and as a check in `scripts/ci.sh`.
# Removes only what is provably this project's and used by no container
# (`podman rmi` without --force refuses an image a container uses):
# - local images named localhost/<project>-* under a name that neither
#   compose.yaml nor scripts/ci.sh builds any more (e.g. a branch tag),
# - dangling images that once carried such a name, i.e. the previous build
#   of an image that has been rebuilt since,
# - upstream images pulled by digest (so they carry no tag) from a repository
#   the repository pins, whose digest it no longer pins. An image someone
#   pulled by tag, possibly for another project, is left alone.
# Prints one line per removal.
#
# Anonymous volumes are not removed but prevented: podman-compose keeps a
# container's anonymous volumes when it recreates it, so an image VOLUME that
# compose.yaml does not cover leaks one volume per `up`. Any container of the
# project mounting one fails this script, naming the path to cover.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJECT=$(sed -n 's/^name: *//p' "$ROOT/compose.yaml")
LOCAL=localhost/$PROJECT-

log() { printf '\033[1mprune:\033[0m %s\n' "$*" >&2; }

remove() { # <image> <description>
  local size
  size=$(podman image inspect --format '{{.Size}}' "$1" 2>/dev/null) || return 0
  podman rmi "$1" >/dev/null 2>&1 || return 0
  log "removed $2 ($((size / 1000000)) MB)"
}

# --- local images ------------------------------------------------------------

wanted=$(grep -ohE "${LOCAL}[a-z0-9-]+:[A-Za-z0-9._-]+" "$ROOT/compose.yaml" "$ROOT/scripts/ci.sh" | sort -u)
for name in $(podman images --format '{{.Repository}}:{{.Tag}}' | grep -E "^${LOCAL}[a-z0-9-]+:" | sort -u); do
  grep -qxF "$name" <<<"$wanted" || remove "$name" "$name, no longer built"
done
for id in $(podman images -a -q --no-trunc --filter dangling=true); do
  history=$(podman image inspect --format '{{range .NamesHistory}}{{println .}}{{end}}' "$id" 2>/dev/null) || continue
  name=$(grep -E "^${LOCAL}[a-z0-9-]+:" <<<"$history" | head -1) || continue
  remove "$id" "a previous build of $name"
done

# --- upstream images ---------------------------------------------------------

pins=$(git -C "$ROOT" ls-files -z compose.yaml containers scripts |
  xargs -0 grep -ohE '[a-z0-9.-]+(/[a-z0-9._-]+)+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}' |
  sed 's/:[^@]*@/@/' | sort -u)
pinned_repos=$(for pin in $pins; do echo "${pin%%@*}"; done | sort -u)
pinned_ids=$(for pin in $pins; do podman image inspect --format '{{.Id}}' "$pin" 2>/dev/null || true; done)
tagged_ids=$(podman images --no-trunc --format '{{.ID}} {{.Tag}}' | awk '$2 != "<none>" { print $1 }' | sed 's/^sha256://')
podman images --no-trunc --format '{{.ID}} {{.Repository}} {{.Tag}}' | sed 's/^sha256://' |
  while read -r id repo tag; do
    [[ $tag == "<none>" ]] || continue
    grep -qxF "$repo" <<<"$pinned_repos" || continue
    grep -qxF "$id" <<<"$pinned_ids" && continue
    grep -qxF "$id" <<<"$tagged_ids" && continue
    remove "$id" "$repo@${id:0:12}, no longer pinned"
  done

# --- anonymous volumes ---------------------------------------------------------

leaks=0
for container in $(podman ps -a --format '{{.Names}}' --filter "label=io.podman.compose.project=$PROJECT"); do
  for dest in $(podman inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}={{.Destination}} {{end}}{{end}}' "$container" |
    tr ' ' '\n' | sed -n 's/^[0-9a-f]\{64\}=//p'); do
    log "$container mounts an anonymous volume at $dest, which leaks one volume per recreate; cover it in compose.yaml"
    leaks=1
  done
done
exit $leaks
