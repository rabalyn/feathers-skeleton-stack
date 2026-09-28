#!/bin/sh
# First initialisation (ADR 0003): the same roles and database that
# entrypoint.sh re-applies on every later start, from one script.
set -eu
sh /usr/local/share/postgres/roles.sh
