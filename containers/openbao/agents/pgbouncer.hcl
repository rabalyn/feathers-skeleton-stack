# OpenBao Agent for `pgbouncer` (ADR 0023). Renders kv/pgbouncer into /run/secrets,
# one file per key, readable by the pgbouncer group only.
vault {
  address = "https://openbao:8200"
  ca_cert = "/openbao/trust/ca.crt"
}

auto_auth {
  method "approle" {
    config = {
      role_id_file_path                   = "/openbao/agent/role_id"
      secret_id_file_path                 = "/run/agent/secret_id"
      remove_secret_id_file_after_reading = false
    }
  }
}

template_config {
  static_secret_render_interval = "1m"
}

# PgBouncer's auth file. Plain passwords let PgBouncer answer the client's
# SCRAM exchange and run its own against PostgreSQL.
template {
  contents    = <<-EOT
  {{ with secret "kv/data/pgbouncer" }}"app" "{{ .Data.data.app_password }}"
  "test" "{{ .Data.data.test_password }}"
  "worker" "{{ .Data.data.worker_password }}"
  {{ end }}
  EOT
  destination = "/run/secrets/userlist.txt"
  perms       = "0440"
}
