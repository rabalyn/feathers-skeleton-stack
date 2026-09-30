#!/bin/sh
# One configuration, parameterised (ADR 0016, 0031): NetBox's virtual host
# exists only where its host name is set.
set -eu
if [ -z "${NGINX_NETBOX_HOST:-}" ]; then
  rm -f /etc/nginx/conf.d/netbox.conf
  echo "30-netbox-vhost: NetBox virtual host disabled"
fi
