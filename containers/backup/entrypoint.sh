#!/bin/sh
# The backup container (ADR 0017) starts as root for one thing: its own log
# directory on the shared log volume, which belongs to the api's user (ADR
# 0021). Then it runs as `backup`, with the groups the image gives it.
set -eu
install -d -o backup -g backup -m 0750 /var/log/app/backup
exec setpriv --reuid=backup --regid=backup --init-groups -- "$@"
