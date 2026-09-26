#!/usr/bin/env bash
# PostgreSQL's entry point (ADR 0003): the image's own, plus roles.sh once
# the server accepts connections on every start, not only the first. Until
# that has run, the healthcheck fails (the marker below), so nothing that
# waits for a healthy postgres connects with a role or password that is not
# there yet. A failing roles.sh stops the server: running with roles that
# do not match their secrets would only fail later, less clearly.
#
# Signals are passed on to the server, which the image stops with SIGINT
# (fast shutdown).
set -euo pipefail

APPLIED=/run/postgresql/roles-applied
rm -f "$APPLIED"

docker-entrypoint.sh "$@" &
pid=$!
trap 'kill -INT "$pid" 2>/dev/null || true' INT
trap 'kill -TERM "$pid" 2>/dev/null || true' TERM

finish() {
  local rc=0
  wait "$pid" || rc=$?
  # A trapped signal ends `wait` early; the server is still shutting down.
  while kill -0 "$pid" 2>/dev/null; do
    rc=0
    wait "$pid" || rc=$?
  done
  exit "$rc"
}

# Over TCP: during the first initialisation the image runs a temporary
# server on the socket only, which must not count as started.
until pg_isready -q -h 127.0.0.1 -U postgres -d postgres; do
  kill -0 "$pid" 2>/dev/null || finish
  sleep 1
done

if gosu postgres sh /usr/local/share/postgres/roles.sh; then
  touch "$APPLIED"
else
  echo "entrypoint: applying the roles failed; stopping" >&2
  kill -INT "$pid"
  wait "$pid" || true
  exit 1
fi
finish
