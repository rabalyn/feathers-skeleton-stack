# OpenBao Agent for `postgres` (ADR 0023). Renders kv/postgres into /run/secrets,
# one file per key, readable by the postgres group only.
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
  contents    = "{{ with secret \"kv/data/postgres\" }}{{ .Data.data.superuser_password }}{{ end }}"
  destination = "/run/secrets/superuser_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/postgres\" }}{{ .Data.data.migrator_password }}{{ end }}"
  destination = "/run/secrets/migrator_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/postgres\" }}{{ .Data.data.app_password }}{{ end }}"
  destination = "/run/secrets/app_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/postgres\" }}{{ .Data.data.test_password }}{{ end }}"
  destination = "/run/secrets/test_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/postgres\" }}{{ .Data.data.worker_password }}{{ end }}"
  destination = "/run/secrets/worker_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/postgres\" }}{{ .Data.data.exporter_password }}{{ end }}"
  destination = "/run/secrets/exporter_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/postgres\" }}{{ .Data.data.backup_password }}{{ end }}"
  destination = "/run/secrets/backup_password"
  perms       = "0440"
}
