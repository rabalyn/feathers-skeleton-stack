# 0064: Self-hosted Grafana, Prometheus, Loki, Alloy, and Dozzle on the production host with fixed budgets

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › Observability policy, Production orchestration, Stack log viewer](../technical-architecture.md#observability-policy)
- Related: [0005](0005-production-log-path.md), [0033](0033-host-firewall.md), [0034](0034-single-host-rootless-quadlet.md), [0035](0035-private-podman-networks.md), [0065](0065-alerting.md)

## Context

Monitoring must be available without a third-party SaaS, and must not starve the application on a shared host.

## Decision

- Run Grafana, Prometheus, Loki, and Dozzle as separate rootless services on the production host. Grafana provides dashboards and alert views, Prometheus stores and evaluates metrics, Loki stores searchable logs, Dozzle provides private operator inspection.
- Run Grafana Alloy as a host systemd service that forwards journald logs to Loki.
- Reserve about **1 CPU and 1.5–2 GiB RAM** for the containerized monitoring stack, with hard per-service CPU and memory limits within that total.
- Persistent volumes: **Prometheus 3 GiB, Loki 6 GiB, Grafana 1 GiB**. Dozzle gets no persistent storage. Alert at 80% usage and enforce retention limits.
- Retain observability data for **14 days** initially.
- Back up Grafana dashboards, alert rules, and configuration, plus Prometheus and Loki configuration that isn't reproducibly defined in the repository.
- Grafana uses only Prometheus data and never connects directly to the application or database.

## Consequences

- No external monitoring dependency.
- Monitoring shares the host's fate: a host outage also silences its monitoring.

## ToDos

- ToDo: [Contradiction] "Grafana uses only Prometheus data", but Loki has no UI of its own and is normally queried through a Grafana datasource, and Grafana and Loki share the `monitoring` network. Loki must be allowed as a datasource.
- ToDo: [Contradiction] Dozzle "may also run privately in production" (optional) in the log-viewer section, but it is a fixed item here and in the Quadlet inventory (ADR 0005, 0034).
- ToDo: [Missing] Actual per-service CPU and memory limits. Alloy's resource use falls outside the budget.
- ToDo: [Clarify] Who installs and configures host Alloy (a root-level host package): this repository or the infrastructure repository (ADR 0004)?
- ToDo: [Verify] A system-level Alloy service can read the deployment user's journal (persistent journald, group membership such as `systemd-journal`).
- ToDo: [Contradiction] The backup requirement appears twice with different scope ("back up Grafana dashboards, alert rules, and configuration" and "any dashboards or alert rules that are not reproducibly defined in the repository"), and no backup job covers it (ADR 0048, 0049). Prefer provisioning dashboards and alerts as code?
- ToDo: [Clarify] How 14-day retention interacts with volume limits (Prometheus size-based retention, Loki compactor retention), i.e. which limit wins.
- ToDo: [Missing] Grafana authentication and the operator access path (SSH tunnel?) (ADR 0033).
- ToDo: [Clarify] Host journald retention and size limits, since logs are also stored locally.
