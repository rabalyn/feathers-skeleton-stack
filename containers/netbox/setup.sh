#!/bin/bash
# netbox-setup (ADR 0031): NetBox's migrations over a direct connection to
# PostgreSQL (ADR 0004), then the seed. A one-shot job before netbox and
# netbox-worker start, at every start, like migrate for the api.
set -euo pipefail
source /opt/netbox/venv/bin/activate
cd /opt/netbox/netbox

if ! ./manage.py migrate --check >/dev/null 2>&1; then
  echo "netbox-setup: applying migrations"
  ./manage.py migrate --no-input
  ./manage.py trace_paths --no-input
  ./manage.py remove_stale_contenttypes --no-input
  ./manage.py reindex --lazy
fi
./manage.py shell --no-startup --no-imports --interface python </opt/netbox/netbox/feathers_netbox/seed.py
echo "netbox-setup: done"
