# OpenBao Agent for `backup` (ADR 0017, 0023). Renders kv/backup into
# /run/secrets, one file per key, readable by the backup group only, and
# keeps its own token in /run/secrets/openbao_token: the backup service uses
# it for OpenBao's raft snapshot, which its policy allows besides kv/backup.
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

  sink "file" {
    config = {
      path = "/run/secrets/openbao_token"
      mode = 0440
    }
  }
}

template_config {
  static_secret_render_interval = "1m"
}

template {
  contents    = "{{ with secret \"kv/data/backup\" }}{{ .Data.data.database_password }}{{ end }}"
  destination = "/run/secrets/database_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/backup\" }}{{ .Data.data.s3_key_id }}{{ end }}"
  destination = "/run/secrets/s3_key_id"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/backup\" }}{{ .Data.data.s3_secret_key }}{{ end }}"
  destination = "/run/secrets/s3_secret_key"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/backup\" }}{{ .Data.data.restic_password }}{{ end }}"
  destination = "/run/secrets/restic_password"
  perms       = "0440"
}
