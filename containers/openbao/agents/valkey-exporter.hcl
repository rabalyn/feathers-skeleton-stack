# OpenBao Agent for `valkey-exporter` (ADR 0022, 0023). redis_exporter reads
# its password from a JSON map keyed by the address with the user in it.
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
  contents    = "{{ with secret \"kv/data/valkey-exporter\" }}{\"rediss://exporter@valkey:6379\": \"{{ .Data.data.valkey_password }}\"}{{ end }}"
  destination = "/run/secrets/passwords.json"
  perms       = "0440"
}
