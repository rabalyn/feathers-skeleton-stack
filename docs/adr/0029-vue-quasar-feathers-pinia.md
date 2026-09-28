# 0029: Build the frontend with Vue 3, Quasar (Vite), and `feathers-pinia`

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Goals, Frontend](../technical-architecture.md#frontend)
- Related: [0017](0017-shared-contracts-package.md), [0023](0023-hybrid-jwt-refresh-cookie.md), [0030](0030-frontend-static-image.md), [0031](0031-frontend-security-baseline.md)

## Context

The frontend needs a component framework, a build tool, and state management that fits Feathers services and real-time updates.

## Decision

- Vue 3.
- Quasar Framework with its Vite-based build.
- `feathers-pinia` for Feathers service state, querying, pagination, and real-time synchronization where needed.
- The output is a generated production bundle of static assets.

## Consequences

- A large UI component library is available out of the box.
- Service state and real-time updates follow Feathers conventions.
- The frontend depends on `feathers-pinia` keeping pace with Vue, Pinia, and Feathers releases.

## ToDos

- ToDo: [Verify] `feathers-pinia`'s maintenance status and compatibility with current Vue 3, Pinia, and Feathers v5 releases; recent release activity has been low. Assess the risk and a fallback (plain Pinia stores around the Feathers client).
- ToDo: [Contradiction] `feathers-pinia`'s auth helpers rely on the Feathers authentication client, which keeps the JWT in `localStorage` by default. The authentication design requires memory-only access tokens and a custom refresh flow (ADR 0023). This needs explicit configuration or custom code.
- ToDo: [Clarify] Quasar mode: SPA only (no SSR, PWA, Capacitor, Electron)? "Static assets" implies SPA.
- ToDo: [Clarify] Router history mode (needs an `index.html` fallback in the static server and Nginx) or hash mode.
- ToDo: [Clarify] Which services use real-time synchronization; this ties into channel authorization (ADR 0008, 0021).
- ToDo: [Clarify] Frontend unit/component test tooling (ADR 0057).
- ToDo: [Clarify] Whether internationalization and accessibility requirements exist or are explicitly out of scope.
