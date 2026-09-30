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

# Included by valkey.conf. Valkey reads it at start only. One user per
# client service, each confined to its own keys (ADR 0010, 0024):
#   api     rate limits (rl:) and enqueueing (bull:)
#   worker  the queues (bull:)
#   test    any key: test files namespace their own
#   probe   PING, for the healthcheck
#   exporter  server statistics for Prometheus, no keys (ADR 0022)
#   netbox  NetBox's job queue (rq:) and cache (:1:), in databases 0 and 1
#           (ADR 0031)
# INFO is @dangerous, and ioredis and BullMQ need it: the ready check, the
# server version and the eviction policy.
template {
  contents    = <<-EOT
  {{ with secret "kv/data/valkey" }}user default off
  user probe on >{{ .Data.data.probe_password }} -@all +ping
  user api on >{{ .Data.data.api_password }} ~rl:* ~bull:* &* +@all -@dangerous +info
  user worker on >{{ .Data.data.worker_password }} ~bull:* &* +@all -@dangerous +info
  user test on >{{ .Data.data.test_password }} ~* &* +@all -@admin
  user netbox on >{{ .Data.data.netbox_password }} ~rq:* ~:1:* &* +@all -@dangerous +info
  user exporter on >{{ .Data.data.exporter_password }} -@all +ping +info +client|setname +config|get +slowlog|get +slowlog|len +latency|latest +latency|histogram +dbsize +select
  {{ end }}
  EOT
  destination = "/run/secrets/valkey-auth.conf"
  perms       = "0440"
}

# For the healthcheck's client.
template {
  contents    = "{{ with secret \"kv/data/valkey\" }}{{ .Data.data.probe_password }}{{ end }}"
  destination = "/run/secrets/probe_password"
  perms       = "0440"
}
