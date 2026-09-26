# OpenBao Agent for `worker` (ADR 0023, 0024). Renders kv/worker into
# /run/secrets, one file per key, readable by the worker's group only.
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
  contents    = "{{ with secret \"kv/data/worker\" }}{{ .Data.data.database_password }}{{ end }}"
  destination = "/run/secrets/database_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/worker\" }}{{ .Data.data.valkey_password }}{{ end }}"
  destination = "/run/secrets/valkey_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/worker\" }}{{ .Data.data.s3_key_id }}{{ end }}"
  destination = "/run/secrets/s3_key_id"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/worker\" }}{{ .Data.data.s3_secret_key }}{{ end }}"
  destination = "/run/secrets/s3_secret_key"
  perms       = "0440"
}
