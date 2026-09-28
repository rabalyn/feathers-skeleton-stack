# 0003: Separate direct local development from containerized integration testing

- Status: Accepted
- Date: 2026-09-14

## Context

The architecture mixes two different operating models:

- It recommends direct local development with Vite/Quasar hot reload for speed.
- It also describes a containerized Nginx profile for integration and end-to-end testing, using the built web image and production-like routing behavior.

The text sometimes reads as though the local environment is expected to use the same containerized topology as CI or production, while other sections clearly treat the developer loop as a direct local server.

ToDo: specify which environment is canonical for browser E2E checks and which one is the default developer workflow.

## Decision

The repository supports two distinct workflows:

1. Local developer workflow: run the frontend locally with Vite/Quasar for fast iteration and direct feedback.
2. Test and deployment workflow: run the built web image behind the repository-owned Nginx container for integration, end-to-end, and production-like browser testing.

These are intentionally different operating modes, not competing definitions of the same environment.

## Consequences

- Developers keep a fast local feedback loop without needing to rebuild container images for every edit.
- Browser and WebSocket integration tests exercise the same routing, proxying, and security assumptions as production.
- The architecture remains explicit about where production-like behavior is validated and where developer convenience is prioritized.
- Teams must not confuse the Vite/Quasar dev server on port 5173 with the containerized Nginx profile on ports 8080 and 8443.

ToDo: align port conventions and environment documentation so local, CI, and test profile names do not overlap in practice.

## ToDos (review 2026-09-14)

- ToDo: [Clarify] The first ToDo above is largely answered by the architecture: browser E2E runs against the built frontend behind test Nginx, never the dev server (ADR 0058), and the default developer loop is direct Vite/Quasar. Confirm and close.
- ToDo: [Contradiction] The Development section also allows running the API and frontend "through the development Compose profile", a third mode (containerized development with bind mounts) that this decision's two workflows don't cover.
- ToDo: [Contradiction] The authentication flow behaves differently in the two workflows. Vite on `http://localhost:5173` is cross-origin to the API and plain HTTP, while the refresh cookie is `Secure; SameSite=Strict` with a fixed path. Without a Vite proxy or HTTPS dev server, login/refresh may not work in the local workflow (ADR 0023, 0053).
- ToDo: [Contradiction] Port `8080` is used both by test Nginx (HTTP) and by the web container. See the port table ToDo in ADR 0053.
