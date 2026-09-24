# 0005: Use Alloy/Loki for production logs and reserve Dozzle for private operator access

- Status: Proposed
- Date: 2026-09-14

## Context

The document states both of the following:

- Dozzle is the selected lightweight local/test log viewer and may run privately in production for operator inspection.
- Grafana Alloy is the host systemd service that forwards journald logs to Loki in production.

This creates a practical ambiguity: is Dozzle the primary production log-viewing path, or is Loki + Alloy the canonical production logging system while Dozzle stays a local or emergency operator tool?

ToDo: define the production log-access model, including who reads which logs, how access is restricted, and whether Dozzle is in the standard production path or only a debugging aid.

## Decision

Production log collection and retention should follow the Alloy-to-Loki path as the standard operational flow. Dozzle remains available for private operator inspection, but it is not the authoritative production log pipeline.

This keeps the operational model consistent with the requirement that host-installed Alloy forwards journald output to the self-hosted Loki service, while Dozzle remains a bounded inspection surface for live runtime debugging.

## Consequences

- Production logging is centralized, searchable, and easier to correlate with metrics and alerts.
- Dozzle remains lightweight and private, without becoming a second operational log source.
- Operators can still inspect container output locally without exposing a broader log surface.
- The team must keep logging configuration documented so the fallback Dozzle path does not drift away from the canonical Loki path.

ToDo: document whether Dozzle is expected to be exposed through SSH tunnel only or whether it is allowed to run on a private loopback port with auth enabled.

## ToDos (review 2026-09-14)

- ToDo: [Clarify] The ToDo above is answered by the architecture: both. Dozzle binds to loopback only, is reached through an SSH tunnel, **and** has authentication enabled. Confirm and close.
- ToDo: [Contradiction] Mounting the Podman API socket "read-only" doesn't restrict the API. A read-only bind mount doesn't stop a process from connecting to a Unix socket, so Dozzle effectively has full control over all of the deployment user's containers (create, exec, delete). Consider Dozzle's agent mode or a filtering socket proxy, or accept the risk explicitly.
- ToDo: [Verify] The Quadlet log driver must let both paths work. `journald` feeds Alloy and still allows `podman logs`; `passthrough` breaks `podman logs` and therefore Dozzle (ADR 0034).
- ToDo: [Contradiction] Dozzle "may also run privately in production" (optional), yet it is a fixed production service in the observability stack and the Quadlet inventory (ADR 0034, 0064).
- ToDo: [Contradiction] "Grafana uses only Prometheus data" conflicts with Loki being searchable, since Loki is normally queried through Grafana (ADR 0064).
- ToDo: [Clarify] Local/CI profiles contain no Loki or Alloy, so the production log pipeline is first exercised in production.
