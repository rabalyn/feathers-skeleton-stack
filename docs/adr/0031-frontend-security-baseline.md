# 0031: Frontend security baseline (CSP, safe rendering, dependency hygiene)

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0004](0004-repo-vs-infrastructure-boundary.md), [0023](0023-hybrid-jwt-refresh-cookie.md), [0054](0054-test-only-nginx.md), [0068](0068-api-security-baseline.md)

## Context

The access token is readable by JavaScript while it sits in memory, so XSS stays the main threat to the authentication model.

## Decision

- Apply a strict Content Security Policy.
- Avoid unsafe HTML rendering.
- Keep dependencies updated.
- Never put secrets in the token payload.
- Protect cookie-based refresh requests with CSRF protection and explicit origin checks (ADR 0023).

## Consequences

- Inline scripts and dynamic code evaluation are restricted, which constrains some libraries.
- Rendering user-supplied HTML requires sanitization or is avoided entirely.

## ToDos

- ToDo: [Clarify] Who sends the CSP and other security headers in production: external Nginx (infrastructure repository) or the web container? The test Nginx must send the same policy, or E2E tests don't validate it (ADR 0004, 0054).
- ToDo: [Missing] The concrete policy: `connect-src` for API and `wss:` WebSocket, `style-src` (Quasar/Vue may need inline styles, a nonce, or hashes), font and icon sources, `frame-ancestors`.
- ToDo: [Clarify] Enforcement of "avoid unsafe HTML" (for example the ESLint rule `vue/no-v-html`).
- ToDo: [Missing] Dependency update tooling and cadence (ADR 0068).
- ToDo: [Clarify] Other headers (HSTS, `X-Content-Type-Options`, `Referrer-Policy`) and who owns them.
- ToDo: [Clarify] Whether CSP violation reporting is wanted.
