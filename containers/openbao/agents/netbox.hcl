# OpenBao Agent for `netbox` (ADR 0023, 0031). Renders kv/netbox into
# /run/secrets for netbox, netbox-worker and netbox-setup, readable by group
# 0, NetBox's. The file names are those the upstream configuration reads.
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
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.database_password }}{{ end }}"
  destination = "/run/secrets/db_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.valkey_password }}{{ end }}"
  destination = "/run/secrets/redis_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.valkey_password }}{{ end }}"
  destination = "/run/secrets/redis_cache_password"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.secret_key }}{{ end }}"
  destination = "/run/secrets/secret_key"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.api_token_pepper }}{{ end }}"
  destination = "/run/secrets/api_token_pepper_1"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.api_token }}{{ end }}"
  destination = "/run/secrets/api_token"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.saml_sp_key }}{{ end }}"
  destination = "/run/secrets/saml_sp_key"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.saml_sp_cert }}{{ end }}"
  destination = "/run/secrets/saml_sp_cert"
  perms       = "0440"
}

template {
  contents    = "{{ with secret \"kv/data/netbox\" }}{{ .Data.data.saml_idp_cert }}{{ end }}"
  destination = "/run/secrets/saml_idp_cert"
  perms       = "0440"
}
