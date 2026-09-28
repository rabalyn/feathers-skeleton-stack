#!/bin/sh
# Renders the configuration from secrets the ldap-agent wrote (ADR 0023),
# seeds an empty directory once, and runs slapd on ldaps:// only.
set -eu

umask 077
mkdir -p /run/slapd /var/lib/openldap/data

hash() { slappasswd -T "/run/secrets/$1" -h '{SSHA}'; }

sed "s|@ROOTPW@|$(hash admin_password)|" /etc/openldap/slapd.conf.in > /run/slapd/slapd.conf

if [ ! -f /var/lib/openldap/data/data.mdb ]; then
  echo "ldap: seeding empty directory"
  slapadd -f /run/slapd/slapd.conf -l /etc/openldap/base.ldif
  slapadd -f /run/slapd/slapd.conf -l /etc/openldap/seed/users.ldif
fi

# Service bind accounts (ADR 0008), passwords from OpenBao. Added when
# missing, so an existing directory gains accounts introduced later.
ensure_account() { # <cn> <secret file>
  slapcat -f /run/slapd/slapd.conf -a "(cn=$1)" | grep -q '^dn:' && return 0
  echo "ldap: adding service account $1"
  printf 'dn: cn=%s,ou=services,dc=feathers,dc=test\nobjectClass: applicationProcess\nobjectClass: simpleSecurityObject\ncn: %s\nuserPassword: %s\n' \
    "$1" "$1" "$(hash "$2")" | slapadd -f /run/slapd/slapd.conf
}
ensure_account keycloak keycloak_password
ensure_account api api_password

chown -R ldap:ldap /run/slapd /var/lib/openldap
exec slapd -d 256 -u ldap -g ldap -f /run/slapd/slapd.conf -h "ldaps:///"
