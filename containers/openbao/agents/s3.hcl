# OpenBao Agent for `s3` (ADR 0020, 0023). Renders kv/s3 into /run/secrets,
# one file per key, readable by Garage's group only: the RPC secret and each
# client's S3 key, which the container imports at start.
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
  contents    = "{{ with secret \"kv/data/s3\" }}{{ .Data.data.rpc_secret }}{{ end }}"
  destination = "/run/secrets/rpc_secret"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/s3\" }}{{ .Data.data.api_key_id }}{{ end }}"
  destination = "/run/secrets/api_key_id"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/s3\" }}{{ .Data.data.api_secret_key }}{{ end }}"
  destination = "/run/secrets/api_secret_key"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/s3\" }}{{ .Data.data.worker_key_id }}{{ end }}"
  destination = "/run/secrets/worker_key_id"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/s3\" }}{{ .Data.data.worker_secret_key }}{{ end }}"
  destination = "/run/secrets/worker_secret_key"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/s3\" }}{{ .Data.data.backup_key_id }}{{ end }}"
  destination = "/run/secrets/backup_key_id"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/s3\" }}{{ .Data.data.backup_secret_key }}{{ end }}"
  destination = "/run/secrets/backup_secret_key"
  perms       = "0440"
}

# Local only (secrets.conf): absent in production, where this renders empty
# and the container skips the client.
template {
  contents    = "{{ with secret \"kv/data/s3\" }}{{ or .Data.data.test_key_id \"\" }}{{ end }}"
  destination = "/run/secrets/test_key_id"
  perms       = "0440"
}

# Local only (secrets.conf): absent in production, where this renders empty
# and the container skips the client.
template {
  contents    = "{{ with secret \"kv/data/s3\" }}{{ or .Data.data.test_secret_key \"\" }}{{ end }}"
  destination = "/run/secrets/test_secret_key"
  perms       = "0440"
}
