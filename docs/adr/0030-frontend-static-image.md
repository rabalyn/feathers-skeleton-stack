# 0030: Ship the frontend as a static-asset container image

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Frontend Containerization Recommendation, Runtime Topology](../technical-architecture.md#frontend-containerization-recommendation)
- Related: [0003](0003-local-vs-containerized-frontend.md), [0032](0032-external-nginx-ingress.md), [0037](0037-compose-and-quadlet-definitions.md), [0038](0038-host-built-images-no-registry.md), [0056](0056-github-actions-ci.md)

## Context

The frontend production artifact is a set of static files. A Node.js development server doesn't belong in production.

## Decision

1. A Node-based build stage installs dependencies and runs lint, type checks, unit tests, and the production build.
2. The generated Quasar assets are copied into a minimal static web-server image.
3. The image serves the assets. The reverse proxy routes API and WebSocket requests. In production the web server listens on `0.0.0.0:8080` inside the container and is published only as `127.0.0.1:8080:8080`.

Developers can still use a local `quasar dev` process; the containerized path is for deployment and integration testing.

## Consequences

- A reproducible deployment artifact built with the same Containerfile in CI and production.
- No Node.js runtime in the production frontend image.

## ToDos

- ToDo: [Missing] The static server inside the image isn't chosen (for example unprivileged Nginx, Caddy, `static-web-server`).
- ToDo: [Contradiction] Running lint, type checks, and unit tests inside the image build duplicates the CI jobs (ADR 0056). Because production images are rebuilt on the production host (ADR 0038), it also runs the frontend test suite on the production host at every release. Decide whether checks belong in the Containerfile or only in CI.
- ToDo: [Clarify] Runtime configuration. A static bundle can't read environment variables: bake values at build time, use same-origin relative URLs, or inject a runtime `config.js` at container start?
- ToDo: [Clarify] Who serves the SPA history fallback and cache headers (hashed assets immutable, `index.html` not cached): the web container or external Nginx?
- ToDo: [Clarify] Who sets security headers such as CSP: the web container, test Nginx, or external Nginx (ADR 0031).
- ToDo: [Missing] Health check for the web container (ADR 0060).
