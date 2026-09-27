#!/usr/bin/env bash
# Runs scripts/ci.sh with the backup target on real NFS, as a CI runner does
# (ADR 0015, 0017): installs an NFS server, exports a directory with
# root_squash, mounts the export as root, and hands the mount point to the
# stack as BACKUP_TARGET. Rootless Podman can neither mount NFS nor serve it,
# so this part needs root; ci.sh itself runs as the user who ran sudo, whose
# rootless Podman runs the stack.
#
#   sudo scripts/ci-nfs-runner.sh [ci.sh options]
#
# Afterwards the export is unmounted and removed, and the backup container
# is back on its named volume. The NFS server package stays installed.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
EXPORT=/srv/feathers-ci-nfs/export
MOUNT=/srv/feathers-ci-nfs/backups
EXPORTS_FILE=/etc/exports.d/feathers-ci.exports
# The backup container's user (containers/api/Containerfile).
BACKUP_UID=1100

log() { printf '\033[1mci-nfs:\033[0m %s %s\n' "$(date +%T)" "$*" >&2; }
die() { log "$*"; exit 1; }

[[ $EUID == 0 ]] || die "run with sudo"
USER_NAME=${SUDO_USER:-}
[[ -n $USER_NAME && $USER_NAME != root ]] || die "run through sudo, as the user whose rootless Podman runs the stack"
USER_ID=$(id -u "$USER_NAME")
as_user() {
  runuser -u "$USER_NAME" -- env HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)" \
    XDG_RUNTIME_DIR="/run/user/$USER_ID" PATH="$PATH" "$@"
}

install_server() {
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nfs-kernel-server >/dev/null
  elif command -v pacman >/dev/null; then
    pacman -S --needed --noconfirm nfs-utils >/dev/null
  elif command -v dnf >/dev/null; then
    dnf install -y -q nfs-utils
  else
    die "no known package manager to install an NFS server with"
  fi
  systemctl start nfs-server
}

# The container's UID 1100 is a subordinate UID on the host; the export
# belongs to that one, as the production export must (ADR 0017).
host_id() { # <uid_map|gid_map> <container id>
  as_user podman unshare cat "/proc/self/$1" |
    awk -v id="$2" '$1 <= id && id < $1 + $3 { print $2 + id - $1; exit }'
}

# Read from /proc/mounts, never by stat(): root cannot stat the root of a
# root_squash export, nor anyone that of an export that is gone (stale handle), so
# `mountpoint` reports such a mount as absent.
mounted() { awk -v m="$MOUNT" '$2 == m { found = 1 } END { exit !found }' /proc/mounts; }

# Unmounts within a minute, or detaches the mount lazily: a hard NFS mount
# can block an unmount for a long time.
unmount() {
  mounted || return 0
  timeout 60 umount "$MOUNT" 2>/dev/null || { log "unmount timed out; detaching lazily"; umount -l "$MOUNT"; }
}

cleanup() {
  set +e
  log "cleanup: moving the backup container back to its named volume"
  (cd "$ROOT" && as_user timeout 300 podman-compose --profile local up -d --force-recreate --no-deps backup >/dev/null 2>&1)
  # ci.sh --cold emptied that volume, and only the NFS target got an init.
  as_user timeout 120 podman exec -u backup backup node dist/backup.js init >/dev/null 2>&1 ||
    log "cleanup: initialising the named volume failed; run scripts/backup.sh init"
  log "cleanup: unmounting $MOUNT"
  unmount
  # One line per step: the removal once took 17 minutes, and which step
  # waited was not visible.
  log "cleanup: unexporting"
  rm -f "$EXPORTS_FILE"
  timeout 60 exportfs -ra || log "cleanup: exportfs did not finish within a minute; continuing"
  log "cleanup: deleting $EXPORT"
  rm -rf "$EXPORT"
  log "cleanup: removing the mount point"
  # Never recursively: were it still mounted, rm would walk the hard NFS mount
  # and wait out its retries.
  mounted && log "cleanup: $MOUNT is still mounted; leaving it"
  rmdir "$MOUNT" 2>/dev/null
  log "cleanup: done"
}

log "installing and starting the NFS server"
install_server
uid=$(host_id uid_map "$BACKUP_UID")
gid=$(host_id gid_map "$BACKUP_UID")
[[ -n $uid && -n $gid ]] || die "no subordinate ID for $BACKUP_UID; see /etc/subuid of $USER_NAME"

# Every run starts on an empty export, as on a fresh runner: repositories an
# interrupted run left behind may be half deleted.
unmount
if [[ -e $EXPORT ]]; then
  log "removing the export an earlier run left behind"
  rm -rf "$EXPORT"
fi

trap cleanup EXIT
mkdir -p "$EXPORT" "$MOUNT"
chown "$uid:$gid" "$EXPORT"
chmod 0750 "$EXPORT"
mkdir -p /etc/exports.d
printf '%s 127.0.0.1(rw,sync,root_squash,no_subtree_check)\n' "$EXPORT" >"$EXPORTS_FILE"
exportfs -ra
log "mounting 127.0.0.1:$EXPORT at $MOUNT"
mount -t nfs -o vers=4.2,hard 127.0.0.1:"$EXPORT" "$MOUNT"
mounted || die "$MOUNT is not mounted"

# root_squash: root on this host is nobody on the export.
if touch "$MOUNT/.root-probe" 2>/dev/null; then
  rm -f "$MOUNT/.root-probe"
  die "root can write the export: root_squash is not in effect"
fi
log "root is squashed on the export"

log "running scripts/ci.sh $* with BACKUP_TARGET=$MOUNT"
as_user env BACKUP_TARGET="$MOUNT" "$ROOT/scripts/ci.sh" "$@"
