# OpenBao Agent for `idp` (ADR 0023). Renders kv/idp into /run/secrets,
# one file per key, readable by the idp group only.
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
  contents    = "{{ with secret \"kv/data/idp\" }}{{ .Data.data.admin_password }}{{ end }}"
  destination = "/run/secrets/admin_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/idp\" }}{{ .Data.data.ldap_bind_password }}{{ end }}"
  destination = "/run/secrets/ldap_bind_password"
  perms       = "0440"
}
