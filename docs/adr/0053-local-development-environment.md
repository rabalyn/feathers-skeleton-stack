# 0053: Local development environment, ports, and explicit seeding

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Development](../technical-architecture.md#development)
- Related: [0003](0003-local-vs-containerized-frontend.md), [0023](0023-hybrid-jwt-refresh-cookie.md), [0037](0037-compose-and-quadlet-definitions.md), [0055](0055-mkcert-local-https.md)

## Context

Developers need fast feedback, repeatable data, and a stack close enough to production to catch integration problems.

## Decision

- Run PostgreSQL in rootless Podman.
- Run PgBouncer, Nginx, and the log viewer in the containerized development/test profile.
- Run the API and frontend either locally for fast reload or through the development Compose profile.
- Default ports: Feathers API `3000`, Vite/Quasar `5173`, test Nginx `8443` (HTTPS) and `8080` (HTTP). Keep the same host ports across local, CI, and the test profile.
- Use the Nginx profile for browser and WebSocket integration testing, with `mkcert` certificates when HTTPS behaviour matters.
- Use non-production databases and credentials.
- Keep migrations and seed data repeatable. Provide an explicit, deterministic seed command such as `pnpm db:seed`; never seed automatically at startup.

## Consequences

- Hot reload is available without containers for application code.
- Seed data is predictable for manual testing.

## ToDos

- ToDo: [Contradiction] Port plan: the web container listens on `8080`, and test Nginx uses host port `8080` for HTTP. If the Compose `web` service publishes `8080`, it collides with test Nginx, so "the same host ports across local, CI, and the test profile" can't hold for both. Write a full port table including PgBouncer, PostgreSQL, Valkey, S3, and Dozzle.
- ToDo: [Contradiction] An API running directly on the host needs host-published PgBouncer, Valkey, and S3 ports, and migrations need a direct PostgreSQL port. That conflicts with "PostgreSQL remains private to the Compose network" (ADR 0014).
- ToDo: [Missing] The development service list omits Valkey and S3, although authentication fails closed without Valkey (ADR 0025).
- ToDo: [Contradiction] The Vite dev server (`http://localhost:5173`) is a different origin from the API (`:3000`), and the refresh cookie is `Secure` and `SameSite=Strict`. Decide on a Vite proxy or an HTTPS dev server (ADR 0023).
- ToDo: [Clarify] Seed content (one user per role? local-only demo passwords) and a database reset command.
- ToDo: [Clarify] Bind mounts and file watching in the development Compose profile under rootless Podman.
- ToDo: [Missing] Developer prerequisites for the README (Podman and Compose tool versions, `mkcert`, Node.js, pnpm).
