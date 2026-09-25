# 0016: Nginx reverse proxy with real TLS in every environment

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0032, 0054, 0055
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0008](0008-authentication-saml2-ldap.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0015](0015-testing-vitest-playwright.md), [0018](0018-owasp-security-baseline.md), [0020](0020-object-storage-uploads.md), [0023](0023-secrets-management.md)

## Context

The refresh cookie is `Secure`, the login flow is a cross-site SAML2 redirect, and both behave differently over plain HTTP. Local development therefore has to use real TLS or it is not testing the thing that will run.

What local TLS needs is a valid certificate chain that browsers, Node and Playwright trust without exceptions. Self-signed leaf certificates behave inconsistently across browsers and tempt tests into ignoring certificate errors. Certificate *issuance* (ACME) adds nothing on a developer machine that nothing outside can reach.

Let's Encrypt is not usable here: its rate limits are too aggressive for the university network this deploys into.

## Decision

Nginx is the reverse proxy and TLS terminator in every environment. Only the source of the certificate differs.

| Environment | Certificate source |
| --- | --- |
| Local, CI | The one-shot `certs` job: creates a local root CA once and issues a certificate for the local host names from it |
| Production | An ACME client against the institutional CA. Which client, endpoint and challenge type are deployment configuration |

### The local CA

- On first start, `certs` creates a root CA and stores it in a volume. On every start it issues or renews the leaf certificate for the configured local host names (by default `app.localhost` and `idp.localhost`) if it is missing or near expiry, together with the server certificate for OpenBao's internal listener ([0023](0023-secrets-management.md)). `*.localhost` resolves to the loopback address in browsers without editing `/etc/hosts`.
- Locally Nginx publishes HTTPS on host port **8443** by default, because rootless Podman cannot bind ports below `net.ipv4.ip_unprivileged_port_start` (1024 by default) and changing that sysctl on every developer machine and runner is not worth it. The local origins are therefore `https://app.localhost:8443` and `https://idp.localhost:8443`. The port is part of the configured public origin, from which the SAML entity ID and ACS URL are derived, so production on 443 differs by configuration only.
- The root is trusted by Playwright's browser context, by Node through `NODE_EXTRA_CA_CERTS`, and — through a documented one-time import — by the developer's own browser. Tests never ignore certificate errors.
- The root's private key never leaves the volume and is unique per machine; nothing about it is committed.

Nginx reads its certificate from one path in every environment and reloads when the file changes, so the production renewal hook and the local job feed the same mechanism.

### Nginx responsibilities

- Terminates TLS; TLS 1.2 and 1.3 only.
- Serves the built frontend bundle, which is part of the `nginx` image, with the SPA history fallback; hashed assets cached immutably and `index.html` not cached. Under the `dev` profile, proxies to the Vite dev server instead ([0014](0014-frontend-quasar-vue.md)).
- Proxies `/api` to the API and upgrades `/api/socket.io` to WebSocket, with an idle timeout longer than the Socket.io ping interval.
- Locally, serves the IdP under its own host name so the browser can complete the SAML redirect ([0008](0008-authentication-saml2-ldap.md)). This virtual host is disabled in production, where the IdP is external.
- Sets `X-Forwarded-For` and `X-Forwarded-Proto`; the API trusts these only from the proxy address, which is what makes the IP-keyed rate limits in [0010](0010-sessions-postgres-ratelimits-valkey.md) meaningful.
- Sends the security headers in [0018](0018-owasp-security-baseline.md), including CSP and HSTS.
- Enforces a request body size **ceiling** as deployment configuration. The upload size limit is a runtime setting validated to stay below this ceiling ([0020](0020-object-storage-uploads.md)).
- Routes `GET /api/ping` like any API path. Health, readiness and metrics are on the API's internal port and are never routed ([0022](0022-observability-and-alerting.md)).

The API is mounted under the `/api` prefix so Feathers service paths cannot collide with SPA routes.

### One configuration, not two

There is a single Nginx configuration, parameterised by environment (server names, certificate path, upstream addresses, whether the IdP virtual host is enabled). Production-specific concerns that belong to the institution — DNS, the public address, the ACME endpoint — are configuration values, not a separate config file.

## Consequences

- TLS, cookie behaviour, SAML redirects and security headers are exercised identically from the first local run.
- Certificate issuance itself is not exercised before production. This is accepted: issuance is a configuration of an off-the-shelf ACME client, and its failure mode is visible (Nginx keeps the last valid certificate and the expiry is monitored).
- Each developer imports one root certificate into their browser once.
