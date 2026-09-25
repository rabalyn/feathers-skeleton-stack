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
  sed "s|@KEYCLOAK_PW@|$(hash keycloak_password)|" /etc/openldap/base.ldif.in > /run/slapd/base.ldif
  slapadd -f /run/slapd/slapd.conf -l /run/slapd/base.ldif
  slapadd -f /run/slapd/slapd.conf -l /etc/openldap/seed/users.ldif
  rm /run/slapd/base.ldif
fi

chown -R ldap:ldap /run/slapd /var/lib/openldap
exec slapd -d 256 -u ldap -g ldap -f /run/slapd/slapd.conf -h "ldaps:///"
