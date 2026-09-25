#!/bin/sh
# Chromium trusts the local root CA the way a developer's browser does after
# the one-time import (ADR 0016): through its NSS store. Nothing is ignored.
set -eu
db="$HOME/.pki/nssdb"
mkdir -p "$db"
[ -f "$db/cert9.db" ] || certutil -d "sql:$db" -N --empty-password
certutil -d "sql:$db" -D -n claude-feathers-local-ca 2>/dev/null || true
certutil -d "sql:$db" -A -t "C,," -n claude-feathers-local-ca -i /trust/ca.crt
exec "$@"
