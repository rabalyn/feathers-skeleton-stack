#!/bin/sh
# OpenBao's entrypoint (ADR 0021, 0023). It starts as root for two things:
# the audit log's directory on the shared log volume, which belongs to the
# api's user, and its own data volume, which a fresh start gives to root.
# OpenBao itself runs as `openbao`.
#
# OpenBao's file audit device never rotates its file; it reopens it on
# SIGHUP. So this script keeps the file bounded the way ADR 0021 bounds
# every log file: over 10 MB, audit.log becomes audit.log.1 (the older ones
# shift up to .5, the oldest is dropped) and OpenBao is told to reopen.
# The rotated names fall outside Alloy's `*.log` glob, so nothing is
# shipped twice.
set -eu

dir=/var/log/app/openbao
log=$dir/audit.log
max_bytes=10485760
keep=5

install -d -o openbao -g openbao -m 0750 "$dir"
# A fresh data volume belongs to the user the container starts as, root;
# OpenBao could not open its raft storage in it.
chown openbao:openbao /openbao/data
chmod 0700 /openbao/data
# The container's output belongs to root; OpenBao's own until 2026-10-02,
# when it wrote its audit log there. An OpenBao initialised before then
# still holds that /dev/stdout device and must open it once to become
# active and drop it, as the configuration no longer declares it.
chown openbao:openbao /proc/self/fd/1 /proc/self/fd/2

su-exec openbao:openbao bao "$@" &
bao=$!
# A stop is passed on to OpenBao, and ends the loop below at once, so the
# script waits for OpenBao rather than for the next half-minute's check.
# Without that it kept sleeping until the stop timeout killed both, OpenBao
# without a clean shutdown (seen 2026-10-06: every stop took 10 seconds).
stopping=
sleeper=
trap 'stopping=1; kill -TERM "$bao" 2>/dev/null || true; [ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null || true' TERM INT

rotate() {
  i=$keep
  while [ "$i" -gt 1 ]; do
    prev=$((i - 1))
    [ ! -e "$log.$prev" ] || mv -f "$log.$prev" "$log.$i"
    i=$prev
  done
  mv -f "$log" "$log.1"
  kill -HUP "$bao"
}

while [ -z "$stopping" ] && kill -0 "$bao" 2>/dev/null; do
  sleep 30 &
  sleeper=$!
  wait "$sleeper" || true
  sleeper=
  [ -z "$stopping" ] || break
  if [ -f "$log" ] && [ "$(stat -c %s "$log")" -ge "$max_bytes" ]; then
    rotate
  fi
done

wait "$bao"
