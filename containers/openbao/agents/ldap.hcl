# OpenBao Agent for `ldap` (ADR 0023). Renders kv/ldap into /run/secrets,
# one file per key, readable by the ldap group only.
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
  contents    = "{{ with secret \"kv/data/ldap\" }}{{ .Data.data.admin_password }}{{ end }}"
  destination = "/run/secrets/admin_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/ldap\" }}{{ .Data.data.keycloak_password }}{{ end }}"
  destination = "/run/secrets/keycloak_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/ldap\" }}{{ .Data.data.api_password }}{{ end }}"
  destination = "/run/secrets/api_password"
  perms       = "0440"
}
