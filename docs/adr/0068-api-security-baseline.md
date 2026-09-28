# 0068: API security baseline (origins, least privilege, consistent hooks, updates)

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Configuration and Security, Backend](../technical-architecture.md#configuration-and-security)
- Related: [0013](0013-typebox-validation-boundary.md), [0015](0015-database-roles-and-connection-paths.md), [0021](0021-casl-role-authorization.md), [0023](0023-hybrid-jwt-refresh-cookie.md), [0031](0031-frontend-security-baseline.md)

## Context

The API is reachable over REST and WebSocket and uses cookies for refresh, which makes origin handling and consistent enforcement essential.

## Decision

- Use least-privilege database credentials for the API.
- Configure CORS and allowed WebSocket origins explicitly.
- Apply authentication and authorization consistently in Feathers hooks and services.
- Make dependency updates and base-image updates part of regular maintenance.

## Consequences

- Cross-origin access has to be listed explicitly per environment.
- Security fixes reach production only through regular releases.

## ToDos

- ToDo: [Clarify] In production, frontend and API share one origin through Nginx, so CORS may not be needed there; in development the origins differ (ADR 0053). Define a per-environment allowed-origin list, shared with the refresh `Origin` check (ADR 0023).
- ToDo: [Missing] Dependency update tooling (Renovate or Dependabot), cadence, and a base-image rebuild policy. Since images are built on the host (ADR 0038), every security patch needs a release.
- ToDo: [Clarify] How "consistently" is enforced, for example a default-deny global hook (authenticate plus authorize on every service) with an explicit allowlist of public endpoints.
- ToDo: [Missing] JSON request body size limits for non-upload requests, and API response security headers.
- ToDo: [Missing] Vulnerability scanning in CI (ADR 0056).
