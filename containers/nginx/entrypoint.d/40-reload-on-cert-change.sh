#!/bin/sh
# Reload when the certificate file changes, so the local certs job and a
# production renewal hook feed the same mechanism (ADR 0016).
set -eu
cert="${NGINX_TLS_DIR:?}/tls.crt"
(
  last=$(stat -c %Y "$cert" 2>/dev/null || echo 0)
  while sleep "${NGINX_CERT_CHECK_SECONDS:-30}"; do
    now=$(stat -c %Y "$cert" 2>/dev/null || echo 0)
    if [ "$now" != "$last" ]; then
      echo "40-reload-on-cert-change: certificate changed, reloading"
      nginx -t -q && nginx -s reload
      last=$now
    fi
  done
) &
