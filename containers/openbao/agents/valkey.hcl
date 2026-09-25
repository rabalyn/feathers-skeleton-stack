# OpenBao Agent for `valkey` (ADR 0023). Renders kv/valkey into /run/secrets,
# readable by the valkey group only.
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

# Included by valkey.conf. Valkey reads it at start only.
template {
  contents    = "{{ with secret \"kv/data/valkey\" }}requirepass \"{{ .Data.data.password }}\"{{ end }}\n"
  destination = "/run/secrets/valkey-auth.conf"
  perms       = "0440"
}

# For the healthcheck's client.
template {
  contents    = "{{ with secret \"kv/data/valkey\" }}{{ .Data.data.password }}{{ end }}"
  destination = "/run/secrets/password"
  perms       = "0440"
}
