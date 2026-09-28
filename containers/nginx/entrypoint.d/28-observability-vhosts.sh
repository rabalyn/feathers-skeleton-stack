#!/bin/sh
# One configuration, parameterised (ADR 0016, 0022): Grafana's and Mailpit's
# virtual hosts exist only where their host names are set.
set -eu
if [ -z "${NGINX_GRAFANA_HOST:-}" ]; then
  rm -f /etc/nginx/conf.d/grafana.conf
  echo "28-observability-vhosts: Grafana virtual host disabled"
fi
if [ -z "${NGINX_MAIL_HOST:-}" ]; then
  rm -f /etc/nginx/conf.d/mail.conf
  echo "28-observability-vhosts: Mailpit virtual host disabled"
fi
