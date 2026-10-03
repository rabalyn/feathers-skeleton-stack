# OpenBao Agent for `postgres-exporter` (ADR 0022, 0023).
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
    # A secret_id issued while the agent waits is picked up within seconds,
    # not after a backoff of up to five minutes (ADR 0023).
    max_backoff = "5s"
  }
}

template_config {
  static_secret_render_interval = "1m"
}

template {
  contents    = "{{ with secret \"kv/data/postgres-exporter\" }}{{ .Data.data.database_password }}{{ end }}"
  destination = "/run/secrets/database_password"
  perms       = "0440"
}
