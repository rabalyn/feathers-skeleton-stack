#!/bin/sh
# One configuration, parameterised (ADR 0016): the built bundle, or the Vite
# dev server when NGINX_WEB_UPSTREAM names one (`scripts/stack.sh up --dev`,
# ADR 0014).
set -eu
snippets=/etc/nginx/conf.d/snippets
if [ -n "${NGINX_WEB_UPSTREAM:-}" ]; then
  cp "$snippets/web-dev.conf" "$snippets/web.conf"
  echo "27-web: proxying the frontend to the dev server at $NGINX_WEB_UPSTREAM"
else
  cp "$snippets/web-static.conf" "$snippets/web.conf"
fi
