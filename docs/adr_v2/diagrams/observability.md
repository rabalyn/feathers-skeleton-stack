# Observability: metrics, logs and alerts

Illustrates [0021](../0021-structured-logging.md) and [0022](../0022-observability-and-alerting.md). Where this page and an ADR or the code disagree, the ADR and the code win. Every hop here is TLS, verified against the CA root.

## Metrics

Prometheus scrapes every target every 15 s on the `observability` network (`containers/prometheus/prometheus.yml`).

```mermaid
flowchart LR
  prom["prometheus :9090<br>14 days"]

  prom -->|":9090 /metrics"| api["api<br>internal port"]
  prom -->|":9090 /metrics"| worker["worker<br>internal port"]
  prom -->|":9187"| pgExp["postgres-exporter"]
  prom -->|":9127"| pgbExp["pgbouncer-exporter"]
  prom -->|":9121"| vkExp["valkey-exporter"]
  prom -->|":3903 /metrics"| s3["s3"]
  prom -->|":9100"| node["node-exporter"]
  prom -->|":3100"| loki["loki"]
  prom -->|":3000"| grafana["grafana"]
  prom -->|":9115 /probe"| bb["blackbox"]

  pgExp -->|"db · :5432"| postgres[("postgres")]
  pgbExp -->|"db · :6432"| pgbouncer[("pgbouncer")]
  vkExp -->|"app-data · :6379"| valkey[("valkey")]
  node -->|"host pid namespace,<br>/ read-only"| hostfs[/"host"/]
  bb -->|"edge · HTTPS :8443<br>GET /api/ping"| nginx["nginx<br>(app.localhost)"]
```

The API's `/health/ready` checks PgBouncer, Valkey and the `uploads` bucket; the same checks reach Prometheus as `dependency_up{dependency}`. The container healthcheck uses `/health/live` only, so a database outage never makes Podman restart the API.

## Logs

```mermaid
flowchart LR
  api["api"] -->|"NDJSON, rotated 10 MB × 6"| logs[/"logs volume<br>&lt;service&gt;.&lt;n&gt;.log"/]
  worker["worker"] --> logs
  backup["backup"] -->|"backup/ subdirectory"| logs

  third["postgres, pgbouncer, s3,<br>idp, nginx, agents, …"] -->|"stdout → Podman → journald"| journal[/"host user journal"/]
  openbao["openbao"] -->|"audit device on stdout<br>(HMACs, never values)"| journal

  logs -->|"read-only mount"| alloy["alloy"]
  journal -->|"read-only mount"| alloy
  alloy -->|"observability · HTTPS :3100<br>labels: service, level, environment"| loki[("loki<br>14 days")]

  dozzle["dozzle (local only)"] -. "Podman socket,<br>not part of the pipeline" .-> journal
```

OpenBao's audit device is drawn as `containers/openbao/server.hcl` configures it: on stdout, "until the shared log volume exists". [0023](../0023-secrets-management.md) says the log volume.

## Alerts

```mermaid
flowchart LR
  grafana["grafana :3000<br>unified alerting,<br>rules provisioned from files"]
  grafana -->|"HTTPS :9090"| prom[("prometheus")]
  grafana -->|"HTTPS :3100"| loki[("loki")]
  grafana -->|"SMTP+STARTTLS :1025<br>plain text"| mail["mail locally,<br>university relay in production"]
  people(["Operators"]) -->|"grafana.localhost via nginx"| grafana
  people -->|"mail.localhost via nginx<br>(local inbox)"| mail
```

| From Loki | From Prometheus |
| --- | --- |
| error lines, rate-limit rejections, break-glass logins, backup errors or no success in 26 h | target down, API not ready, 5xx ratio, p95 latency, DB connections, volume > 80 %, uptime probe, certificate expiry |
