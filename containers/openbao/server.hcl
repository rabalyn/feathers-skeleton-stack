# Identical in every environment (ADR 0023).
storage "raft" {
  path    = "/openbao/data"
  node_id = "openbao"
}

listener "tcp" {
  address       = "0.0.0.0:8200"
  tls_cert_file = "/openbao/tls/fullchain.crt"
  tls_key_file  = "/openbao/tls/tls.key"
  tls_min_version = "tls12"
}

api_addr      = "https://openbao:8200"
cluster_addr  = "https://openbao:8201"
ui            = false

# Audit device (ADR 0023). OpenBao only accepts audit devices declared in
# configuration. It writes to the shared log volume, which Alloy ships to
# Loki (ADR 0021); entries carry HMACs of values, never the values. The
# entrypoint rotates the file and sends SIGHUP, on which OpenBao reopens it.
# A request whose audit entry cannot be written is refused.
audit "file" "file" {
  options {
    file_path = "/var/log/app/openbao/audit.log"
    mode      = "0640"
  }
}
