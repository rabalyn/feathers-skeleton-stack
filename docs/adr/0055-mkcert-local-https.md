# 0055: Use `mkcert` for local HTTPS in the test Nginx profile

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Nginx and local TLS](../technical-architecture.md#nginx-and-local-tls)
- Related: [0023](0023-hybrid-jwt-refresh-cookie.md), [0053](0053-local-development-environment.md), [0054](0054-test-only-nginx.md), [0058](0058-playwright-e2e.md)

## Context

The refresh cookie is `Secure`, so browser tests need HTTPS that browsers trust in order to behave like production.

## Decision

Use a locally trusted development CA such as `mkcert`, and mount the generated certificate and key into the test Nginx container. That keeps `Secure` refresh-cookie behaviour identical in local browser E2E tests and production, avoids browser warnings, and keeps certificates out of version control. A self-signed certificate is acceptable for non-browser smoke checks, with explicit trust configuration. Production certificates are provisioned externally and are never generated or stored by this repository.

## Consequences

- Developers install a local CA once.
- Browser tests see real HTTPS semantics.

## ToDos

- ToDo: [Clarify] CI handling: generate an `mkcert` CA inside the job and trust it in the Playwright browsers, or use a self-signed certificate with ignored HTTPS errors (weakening the "identical behaviour" goal)?
- ToDo: [Clarify] Hostname used for the certificate and cookies (`localhost` or something like `app.localhost`).
- ToDo: [Missing] Certificate file locations, mount paths, and `.gitignore` entries.
- ToDo: [Clarify] Developer guidance on protecting the `mkcert` root CA key, which is trusted system-wide.
