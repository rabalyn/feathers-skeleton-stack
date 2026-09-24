# 0065: Baseline alert set with an owner and response action per alert

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (before first production release)
- Source: [Technical architecture › Observability policy, Backup policy, PostgreSQL operations](../technical-architecture.md#observability-policy)
- Related: [0035](0035-private-podman-networks.md), [0048](0048-postgresql-backup-restic-nfs.md), [0050](0050-nfs-backup-mount.md), [0062](0062-prometheus-metrics.md), [0064](0064-observability-stack.md)

## Context

A single-host deployment run by one operator needs a small, actionable alert set.

## Decision

Define alerts for:

- sustained API 5xx errors and high latency;
- failed readiness;
- PgBouncer pool exhaustion;
- PostgreSQL storage (80%) or connection pressure;
- observability volume usage at 80%;
- business-metric query latency above 500 ms;
- backup job failure (immediately), an unavailable NFS mount, and no successful coordinated backup within 26 hours;
- certificate expiry in the external platform.

Every alert has an owner and a response action. Review logs and alerts after the first releases and adjust thresholds based on observed normal behaviour.

## Consequences

- Operators are told about outages, capacity problems, and backup gaps.
- Thresholds start as guesses and must be tuned.

## ToDos

- ToDo: [Missing] Evaluation and notification path: Grafana alerting, or Prometheus with Alertmanager, and the delivery channel (email, chat, push). Email-based delivery also depends on outbound egress (ADR 0035).
- ToDo: [Contradiction] Several alert sources are unreachable. Prometheus can't scrape PgBouncer, PostgreSQL, host, or backup metrics under the current network plan, and no exporters are defined (ADR 0035). The backup job's reporting path is also undefined (ADR 0051).
- ToDo: [Clarify] "Certificate expiry in the external platform": certificates belong to the infrastructure repository (ADR 0004). Does this stack probe them (for example with a blackbox exporter), or does the infrastructure side alert?
- ToDo: [Missing] Concrete thresholds and durations for "sustained" and "high".
- ToDo: [Clarify] Owner per alert when there is one operator; on-call expectations; location of response runbooks.
- ToDo: [Missing] A dead-man's switch or external heartbeat. Monitoring runs on the same host, so a host outage raises no alert.
- ToDo: [Missing] Alerts for Valkey unavailability (logins fail closed), maintenance-job failure (ADR 0028), S3 availability, and restore-drill overdue.
