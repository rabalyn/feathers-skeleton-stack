#!/bin/sh
# One configuration, parameterised (ADR 0015, 0016): the e2e virtual host
# exists only where its host name is set, which is locally and in CI.
set -eu
if [ -z "${NGINX_E2E_HOST:-}" ]; then
  rm -f /etc/nginx/conf.d/e2e.conf
  echo "29-e2e-vhost: e2e virtual host disabled"
fi
