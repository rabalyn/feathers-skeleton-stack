# OpenBao Agent for `test` (ADR 0023). Renders kv/test into /run/secrets,
# one file per key, readable by the test group only.
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

template {
  contents    = "{{ with secret \"kv/data/test\" }}{{ .Data.data.database_password }}{{ end }}"
  destination = "/run/secrets/database_password"
  perms       = "0440"
}
