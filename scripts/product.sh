# shellcheck shell=bash
# The product's identity (ADR 0035), sourced by every script that drives the
# local stack, after it has set ROOT. Exports product.env for compose.yaml,
# which interpolates it, and derives the local names from it.
#
# Locally, every container is named <project>-<service>, so that several
# products' stacks run side by side; in production each product runs as a
# user of its own and the units keep the bare service names. `ctr <service>`
# is a container's local name.

set -a
# shellcheck source=product.env
source "$ROOT/product.env"
set +a

[[ $PRODUCT =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ && $PRODUCT != *--* ]] ||
  { echo "product.env: PRODUCT must be lowercase letters, digits and single hyphens, starting with a letter" >&2; exit 1; }
[[ -n ${PRODUCT_DISPLAY_NAME:-} ]] || { echo "product.env: PRODUCT_DISPLAY_NAME is empty" >&2; exit 1; }
for _port in "$PRODUCT_HTTPS_PORT" "$PRODUCT_HTTP_PORT"; do
  [[ $_port =~ ^[1-9][0-9]{2,4}$ ]] && ((_port < 65536)) ||
    { echo "product.env: $_port is not a port" >&2; exit 1; }
done
unset _port

CONTAINER_PREFIX=$PRODUCT-
# The local public host names sit below this domain: app.<domain> and so on.
LOCAL_DOMAIN=$PRODUCT.localhost
# The scripts shared with production (openbao-lib.sh, backup.sh) take the
# container names from these.
OPENBAO_CONTAINER=${CONTAINER_PREFIX}openbao
AGENT_PREFIX=$CONTAINER_PREFIX

ctr() { printf '%s%s' "$CONTAINER_PREFIX" "$1"; }

# https://<name>.<domain>:<port>, the local origin of a public host name.
local_origin() { printf 'https://%s.%s:%s' "$1" "$LOCAL_DOMAIN" "$PRODUCT_HTTPS_PORT"; }
