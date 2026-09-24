# 0033: Expose only HTTPS (and optional HTTP) publicly on the production host

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › Runtime Topology](../technical-architecture.md#runtime-topology)
- Related: [0001](0001-production-valkey.md), [0004](0004-repo-vs-infrastructure-boundary.md), [0032](0032-external-nginx-ingress.md), [0064](0064-observability-stack.md)

## Context

All application and operations services run on one host. Only public ingress and management access should be reachable from outside.

## Decision

The production host firewall exposes HTTPS publicly, optionally HTTP for redirects or certificate issuance, and restricts SSH to an approved management source. API, web, Loki, Dozzle, S3, PostgreSQL, PgBouncer, Prometheus, and Grafana ports stay loopback-only or private-network-only.

## Consequences

- Operators reach internal UIs only through SSH (for example tunnels).
- Misconfigured container port publishing is a second line of defence behind the firewall, not the only one.

## ToDos

- ToDo: [Clarify] Who owns and applies the firewall configuration: this repository, the infrastructure repository, or manual host setup (ADR 0004).
- ToDo: [Contradiction] The list of internal-only services omits Valkey (a production service per ADR 0001), exporters, and Alloy.
- ToDo: [Clarify] "Optionally HTTP": decide whether port 80 is open.
- ToDo: [Missing] How operators reach Grafana and the Prometheus UI. Only Dozzle has an explicit SSH-tunnel rule (ADR 0005).
- ToDo: [Missing] Outbound (egress) policy: email provider (ADR 0026), npm and image registries for on-host builds (ADR 0038), GitHub, NTP.
- ToDo: [Clarify] Where the "approved management source" is defined (deployment configuration, ADR 0070).
