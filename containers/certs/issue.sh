#!/bin/sh
# Local and CI certificate authority (ADR 0016). Production uses ACME for the
# public name; nothing here runs there.
#
# Volumes:
#   /ca        private: the root key, never mounted anywhere else
#   /trust     public:  ca.crt, mounted read-only by everything that verifies
#   /tls/nginx          nginx leaf for the public host names
#   /tls/openbao        OpenBao listener leaf (ADR 0023)
#
# The root is created once. Leaves are (re)issued when missing, when they
# expire within RENEW_DAYS, or when their names no longer match.
set -eu

: "${CERT_HOSTNAMES:?comma-separated public host names, e.g. app.localhost,idp.localhost}"
LEAF_DAYS="${LEAF_DAYS:-90}"
RENEW_DAYS="${RENEW_DAYS:-30}"
OPENBAO_UID="${OPENBAO_UID:-100}"
OPENBAO_GID="${OPENBAO_GID:-1000}"

umask 077

if [ ! -s /ca/ca.key ]; then
  echo "certs: creating local root CA"
  openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout /ca/ca.key -out /ca/ca.crt -days 3650 \
    -subj "/CN=claude-feathers local CA $(hostname)-$(date +%s)" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
fi
install -m 0644 /ca/ca.crt /trust/ca.crt

san_list() {
  out=""
  for name in $(echo "$1" | tr ',' ' '); do
    case "$name" in
      *[!0-9.]*) out="${out:+$out,}DNS:$name" ;;
      *) out="${out:+$out,}IP:$name" ;;
    esac
  done
  echo "$out"
}

# issue <dir> <comma-separated names> <owner uid:gid>
issue() {
  dir=$1 names=$2 owner=$3
  san=$(san_list "$names")
  if [ -s "$dir/tls.crt" ] \
    && openssl x509 -in "$dir/tls.crt" -noout -checkend $((RENEW_DAYS * 86400)) >/dev/null \
    && [ "$(cat "$dir/.san" 2>/dev/null)" = "$san" ] \
    && openssl verify -CAfile /ca/ca.crt "$dir/tls.crt" >/dev/null 2>&1; then
    echo "certs: $dir is current"
    return
  fi
  echo "certs: issuing $dir for $san"
  first=$(echo "$names" | cut -d, -f1)
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$dir/tls.key.new" -out "$dir/tls.csr" -subj "/CN=$first"
  printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$san" > "$dir/ext.cnf"
  openssl x509 -req -in "$dir/tls.csr" -CA /ca/ca.crt -CAkey /ca/ca.key -CAcreateserial \
    -days "$LEAF_DAYS" -extfile "$dir/ext.cnf" -out "$dir/tls.crt.new"
  cat "$dir/tls.crt.new" /ca/ca.crt > "$dir/fullchain.crt.new"
  chown "$owner" "$dir/tls.key.new" "$dir/tls.crt.new" "$dir/fullchain.crt.new"
  chmod 0400 "$dir/tls.key.new"
  chmod 0444 "$dir/tls.crt.new" "$dir/fullchain.crt.new"
  # Key first, then certificate: a watcher reloading on the certificate
  # change always sees a matching key.
  mv "$dir/tls.key.new" "$dir/tls.key"
  mv "$dir/fullchain.crt.new" "$dir/fullchain.crt"
  mv "$dir/tls.crt.new" "$dir/tls.crt"
  echo "$san" > "$dir/.san"
  rm -f "$dir/tls.csr" "$dir/ext.cnf"
}

issue /tls/nginx "$CERT_HOSTNAMES" 0:0
issue /tls/openbao "openbao,127.0.0.1" "$OPENBAO_UID:$OPENBAO_GID"
echo "certs: done"
