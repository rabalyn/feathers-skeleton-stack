# 0054: Repository-owned, test-only Nginx for integration and end-to-end tests

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Nginx and local TLS, CI](../technical-architecture.md#nginx-and-local-tls)
- Related: [0003](0003-local-vs-containerized-frontend.md), [0004](0004-repo-vs-infrastructure-boundary.md), [0031](0031-frontend-security-baseline.md), [0032](0032-external-nginx-ingress.md), [0037](0037-compose-and-quadlet-definitions.md)

## Context

Browser routing, API proxying, WebSocket upgrades, and security headers must be tested behind a reverse proxy, but production Nginx belongs to another repository.

## Decision

Use Nginx in integration and end-to-end testing so that browser routing, API proxying, WebSocket upgrades, and production-like headers are exercised. The repository owns a test-only Nginx configuration and image (`nginx/`, `Containerfile.nginx`). Production Nginx configuration and certificates remain external deliverables. The containerized test profile runs the built web image behind the test Nginx container. CI builds the test Nginx image from its own Containerfile.

## Consequences

- Proxy-related bugs appear before production.
- Two Nginx configurations exist and can drift apart.

## ToDos

- ToDo: [Contradiction] The test configuration lives here, production Nginx lives in the infrastructure repository, so "production-like headers" are only as close to production as manual syncing keeps them. Define a shared contract (routes, headers, CSP, timeouts, body size, excluded paths) and who keeps both sides aligned.
- ToDo: [Contradiction] Does test Nginx serve static files itself, or proxy to the `web` container (ADR 0037)?
- ToDo: [Clarify] Pin the Nginx version, and say whether it must match the production Nginx version.
- ToDo: [Missing] A test that `/health/*` and `/metrics` aren't reachable through Nginx, mirroring the production rule (ADR 0032).
