#!/bin/sh
# One configuration, parameterised (ADR 0016): the IdP virtual host exists
# only where the IdP is local.
set -eu
if [ -z "${NGINX_IDP_HOST:-}" ]; then
  rm -f /etc/nginx/conf.d/idp.conf
  echo "25-idp-vhost: IdP virtual host disabled"
fi
