# OpenBao Agent for `grafana` (ADR 0022, 0023): the admin password, the
# key Grafana encrypts its stored secrets with, and the SMTP login.
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
  contents    = "{{ with secret \"kv/data/grafana\" }}{{ .Data.data.admin_password }}{{ end }}"
  destination = "/run/secrets/admin_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/grafana\" }}{{ .Data.data.secret_key }}{{ end }}"
  destination = "/run/secrets/secret_key"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/grafana\" }}{{ .Data.data.smtp_password }}{{ end }}"
  destination = "/run/secrets/smtp_password"
  perms       = "0440"
}
