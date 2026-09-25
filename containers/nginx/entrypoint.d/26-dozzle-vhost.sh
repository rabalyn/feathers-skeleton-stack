#!/bin/sh
# One configuration, parameterised (ADR 0016): the Dozzle virtual host exists
# only in the local stack.
set -eu
if [ -z "${NGINX_DOZZLE_HOST:-}" ]; then
  rm -f /etc/nginx/conf.d/dozzle.conf
  echo "26-dozzle-vhost: Dozzle virtual host disabled"
fi
