# 0023: Hybrid JWT authentication with in-memory access tokens and an HttpOnly refresh cookie

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0022](0022-local-password-authentication.md), [0024](0024-refresh-session-storage.md), [0029](0029-vue-quasar-feathers-pinia.md), [0031](0031-frontend-security-baseline.md), [0032](0032-external-nginx-ingress.md), [0053](0053-local-development-environment.md)

## Context

Access tokens kept in `localStorage` are exposed to XSS for their whole lifetime. Cookie-only authentication doesn't fit Feathers' WebSocket authentication. The architecture chooses a hybrid model.

## Decision

- The frontend keeps a **5-minute access JWT in memory** and uses it for REST and WebSocket authentication. It refreshes the token **60 seconds before expiry**.
- A **30-day refresh credential** is stored in an `HttpOnly; Secure; SameSite=Strict; Path=/authentication/refresh` cookie and is used only by the `/authentication/refresh` endpoint.
- The refresh handler validates the `Origin` header against the configured frontend origin. Cookie-based refresh requests require CSRF protection and explicit origin checks.
- The frontend re-authenticates the Feathers WebSocket connection after every refresh or reconnect.
- Normal logout revokes only the current refresh session. A separate logout-all operation revokes all sessions of the user.
- If refresh fails: clear authentication state, close the WebSocket, redirect to login.
- The API verifies account validity on requests and defines explicit refresh-token revocation and token-family invalidation behaviour (ADR 0024).
- No secrets are placed in the token payload.

## Consequences

- An XSS attacker can steal at most a short-lived access token, not the refresh credential.
- A custom refresh endpoint, cookie handling, and client-side refresh scheduling must be built.
- Every WebSocket connection must be re-authenticated periodically.

## ToDos

- ToDo: [Clarify] Feathers v5 has no built-in refresh-token endpoint. `/authentication/refresh` must be custom, as a Feathers service or a plain HTTP route. Cookies aren't available to Socket.io service calls, so it must be REST-only. Decide the implementation.
- ToDo: [Contradiction] Because the cookie is scoped to `Path=/authentication/refresh`, the browser won't send it to a logout endpoint on any other path, yet logout must revoke "the current refresh session". Put logout under the cookie path (for example `DELETE /authentication/refresh`), include a session ID in the access JWT, or change the path. Clearing the cookie also requires a `Set-Cookie` with the same `Path`.
- ToDo: [Clarify] "The API must verify account validity on requests": what is checked (user exists, not disabled, role unchanged, session not revoked), and at what cost (one database lookup per REST request and per socket call?). Without a session-ID check, access tokens stay valid for up to 5 minutes after logout, logout-all, password change, or account disable.
- ToDo: [Clarify] Which CSRF protection is required beyond `SameSite=Strict` plus `Origin` validation (for example a custom request header), and how a request without an `Origin` header is handled.
- ToDo: [Contradiction] There is a single "configured frontend origin", but local work uses at least two (`http://localhost:5173` for Vite, `https://localhost:8443` for test Nginx, ADR 0053). Allow a per-environment list?
- ToDo: [Contradiction] In local development Vite (port 5173) and the API (port 3000) are different origins. Refresh then needs CORS with credentials, and not every browser accepts a `Secure` cookie over plain `http://localhost` (WebKit in particular). Decide between a Vite proxy (same origin) and HTTPS for the dev server (ADR 0053, 0055).
- ToDo: [Verify] The Feathers authentication client stores the access token in `localStorage` by default, and `feathers-pinia`'s auth store builds on it. Configure in-memory storage explicitly, or the design is silently violated (ADR 0029).
- ToDo: [Clarify] On page reload or in a new tab no access token exists in memory, so the app must call refresh on startup. Document this, including multi-tab coordination (ADR 0024).
- ToDo: [Clarify] Whether the 30-day lifetime is absolute (from login, per token family) or sliding (renewed on every rotation).
- ToDo: [Missing] JWT signing algorithm, secret source, `aud`/`iss` claims, and signing-key rotation procedure (ADR 0067).
- ToDo: [Verify] What Feathers v5 does when an access token expires on an authenticated socket connection. Make sure the 60-second-early refresh and re-authentication avoid gaps and duplicate login events.
- ToDo: [Clarify] "If refresh fails… redirect to login": distinguish a 401 from a transient network error so offline users aren't logged out.
- ToDo: [Clarify] If the public API is mounted under a prefix such as `/api` (ADR 0032), the cookie path and endpoint path change accordingly.
