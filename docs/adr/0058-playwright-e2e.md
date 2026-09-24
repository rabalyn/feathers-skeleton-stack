# 0058: Playwright end-to-end tests against the built frontend behind test Nginx

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Recommended CI and browser testing](../technical-architecture.md#recommended-ci-and-browser-testing)
- Related: [0023](0023-hybrid-jwt-refresh-cookie.md), [0054](0054-test-only-nginx.md), [0055](0055-mkcert-local-https.md), [0056](0056-github-actions-ci.md)

## Context

Authentication with cookies, routing through a proxy, and real-time updates only behave realistically in a real browser against built artifacts.

## Decision

Use Playwright for browser end-to-end tests (Chromium, Firefox, and WebKit support; TypeScript; auto-waiting; traces and screenshots on failure). The first suite covers login, one authenticated read/write workflow, logout, API routing through Nginx, and a WebSocket or real-time update if the application uses one. It runs against the built frontend behind the test Nginx container, not against the development server.

## Consequences

- E2E tests validate real deployment artifacts.
- The E2E job needs the full container stack and trusted HTTPS.

## ToDos

- ToDo: [Clarify] Browser matrix in CI: Chromium only, or all three? WebKit matters for `Secure`-cookie and `localhost` edge cases.
- ToDo: [Contradiction] "A WebSocket or real-time update **if the application uses one**", but the authentication design already requires WebSocket authentication and re-authentication (ADR 0023), and CI requires a WebSocket upgrade check. Make it unconditional.
- ToDo: [Missing] Coverage for access-token refresh (for example with a shortened TTL in test configuration), refresh-token reuse detection, rate limiting, and upload/download.
- ToDo: [Clarify] How E2E test users and data are provisioned (seed command or API setup per test).
- ToDo: [Clarify] Retention of traces and screenshots as CI artifacts.
