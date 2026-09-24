# 0032: Route production traffic through external Nginx to loopback-published API and web containers

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › Runtime Topology, Production orchestration](../technical-architecture.md#runtime-topology)
- Related: [0004](0004-repo-vs-infrastructure-boundary.md), [0025](0025-authentication-rate-limiting.md), [0033](0033-host-firewall.md), [0045](0045-upload-validation-limits.md), [0060](0060-health-endpoints.md), [0062](0062-prometheus-metrics.md)

## Context

Public ingress, TLS certificates, and DNS are managed by a separate infrastructure repository, but the proxy runs on the same host as this application stack.

## Decision

```text
Browser --HTTPS--> externally managed Nginx -> frontend assets
                                      \-> Feathers API --pool--> PgBouncer -> PostgreSQL
                                      \-> WebSocket upgrade
```

- Feathers listens on `0.0.0.0:3000` inside its container; Quadlet publishes it only as `127.0.0.1:3000:3000`.
- The web server listens on `0.0.0.0:8080` inside its container; it is published only as `127.0.0.1:8080:8080`.
- External Nginx proxies frontend requests to the web loopback upstream and REST/WebSocket requests to the API loopback upstream.
- The WebSocket route uses HTTP/1.1 upgrade headers and an explicit idle timeout.
- External Nginx does not route S3, observability services, `/health/*`, or `/metrics`.

## Consequences

- Nothing in the application stack is published on a non-loopback interface.
- Correct behaviour depends on routing rules maintained in another repository.

## ToDos

- ToDo: [Missing] A rule that separates API paths from frontend paths. Feathers services at the root (for example `/users`) collide with SPA routes. Define an API prefix (for example `/api`) and the Socket.io path; this also changes the refresh cookie path (ADR 0023).
- ToDo: [Contradiction] `/health/*` and `/metrics` are served by the same API listener on port 3000 that external Nginx proxies publicly. "Not routed" relies entirely on exclusions in the infrastructure repository, and ADR 0062's "private monitoring network only" doesn't hold, because loopback and every API network reach that port. Consider a separate internal port for health and metrics.
- ToDo: [Missing] The WebSocket idle timeout value, and the matching Socket.io ping interval (must be shorter).
- ToDo: [Missing] Forwarded headers (`X-Forwarded-For`, `X-Forwarded-Proto`) and the API's trusted-proxy configuration, needed for IP rate limits (ADR 0025) and secure-cookie decisions.
- ToDo: [Verify] Rootless Podman port forwarding (rootlessport/pasta) honours the loopback-only publish, and check which source IP the container sees.
- ToDo: [Missing] Upload-related proxy settings (request body size ≥ 50 MiB, request buffering, timeouts) to coordinate with the infrastructure repository (ADR 0045).
- ToDo: [Missing] A written interface contract for the infrastructure repository (upstreams, paths, headers, timeouts, excluded routes), and where it is maintained.
