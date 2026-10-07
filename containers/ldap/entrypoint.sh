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

# Group memberships for NetBox (ADR 0031), added once to any directory.
if ! slapcat -f /run/slapd/slapd.conf -a "(ou=groups)" | grep -q '^dn:'; then
  echo "ldap: adding the groups"
  slapadd -f /run/slapd/slapd.conf -l /etc/openldap/seed/groups.ldif
fi

# Further attributes of the test people (ADR 0008), added once to any
# directory.
if ! slapcat -f /run/slapd/slapd.conf -a "(&(cn=ad01admn)(groupMembership=*))" | grep -q '^dn:'; then
  echo "ldap: adding the people's further attributes"
  slapmodify -f /run/slapd/slapd.conf -l /etc/openldap/seed/attributes.ldif
fi

# The test people's card numbers (ADR 0008), added once to any directory.
if ! slapcat -f /run/slapd/slapd.conf -a "(&(cn=ad01admn)(idmUserAssignedCardSnMifare=*))" | grep -q '^dn:'; then
  echo "ldap: adding the people's card numbers"
  slapmodify -f /run/slapd/slapd.conf -l /etc/openldap/seed/cards.ldif
fi
# Its equality index, rebuilt offline at every start: slapmodify leaves it
# incomplete, and an exact lookup then misses people who hold a card.
slapindex -q -f /run/slapd/slapd.conf idmUserAssignedCardSnMifare

# More people than one search returns (ADR 0008), added once to any directory.
if ! slapcat -f /run/slapd/slapd.conf -a "(cn=bk001blk)" | grep -q '^dn:'; then
  echo "ldap: adding the bulk people"
  slapadd -f /run/slapd/slapd.conf -l /etc/openldap/seed/bulk.ldif
fi

chown -R ldap:ldap /run/slapd /var/lib/openldap
exec slapd -d 256 -u ldap -g ldap -f /run/slapd/slapd.conf -h "ldaps:///"
