#!/bin/bash
# Local and CI identity provider (ADR 0008). Keycloak takes its bootstrap
# admin password and the realm's LDAP bind credential only from environment
# variables, so this shim reads the files the idp-agent rendered and exports
# them into Keycloak's process alone (ADR 0023).
set -euo pipefail

KC_BOOTSTRAP_ADMIN_USERNAME=admin
KC_BOOTSTRAP_ADMIN_PASSWORD=$(</run/secrets/admin_password)
LDAP_BIND_CREDENTIAL=$(</run/secrets/ldap_bind_password)
export KC_BOOTSTRAP_ADMIN_USERNAME KC_BOOTSTRAP_ADMIN_PASSWORD LDAP_BIND_CREDENTIAL

# Dev mode with Keycloak's embedded storage: fast, self-contained, never
# production (the university IdP is). The realm is imported on first start
# and kept, with its signing key, on the idp-data volume.
exec /opt/keycloak/bin/kc.sh start-dev --import-realm "$@"
