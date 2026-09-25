# OpenBao Agent for `api` (ADR 0023). Renders kv/api into /run/secrets,
# one file per key, readable by the api's group only.
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
  contents    = "{{ with secret \"kv/data/api\" }}{{ .Data.data.auth_signing_secret }}{{ end }}"
  destination = "/run/secrets/auth_signing_secret"
  perms       = "0440"
}
