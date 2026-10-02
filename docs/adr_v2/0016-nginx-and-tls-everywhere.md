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

- On first start, `certs` creates a root CA and stores it in a volume. On every start it issues or renews the leaf certificate for the configured local host names (by default `app.localhost`, `e2e.localhost`, `idp.localhost`, `dozzle.localhost`, `grafana.localhost`, `mail.localhost` and `netbox.localhost`) if it is missing or near expiry, together with the server certificates of the internal TLS listeners: OpenBao ([0023](0023-secrets-management.md)), PgBouncer and PostgreSQL ([0004](0004-pgbouncer-pools.md)), the object store ([0020](0020-object-storage-uploads.md)), and the local test directory ([0008](0008-authentication-saml2-ldap.md)). `*.localhost` resolves to the loopback address in browsers without editing `/etc/hosts`.
- Locally Nginx publishes HTTPS on host port **8443** by default, because rootless Podman cannot bind ports below `net.ipv4.ip_unprivileged_port_start` (1024 by default) and changing that sysctl on every developer machine and runner is not worth it. The local origins are therefore `https://app.localhost:8443`, `https://idp.localhost:8443` and `https://dozzle.localhost:8443`. The port is part of the configured public origin, from which the SAML entity ID and ACS URL are derived, so production on 443 differs by configuration only. Nginx listens on that same public port inside the container network too, so a client inside the stack (the end-to-end browser, [0015](0015-testing-vitest-playwright.md)) reaches exactly the origin a developer's browser does.
- The root is trusted by Playwright's browser context, by Node through `NODE_EXTRA_CA_CERTS`, and — through a documented one-time import — by the developer's own browser. Tests never ignore certificate errors.
- The root's private key never leaves the volume and is unique per machine; nothing about it is committed.
- A cold local reset keeps the root CA and discards everything else, including the leaf certificates, so the browser import survives it and leaf issuance still runs from scratch. Replacing the root is a separate, explicit step (`scripts/stack.sh reset --ca`), after which the root has to be imported again.

Nginx reads its certificate from one path in every environment and reloads when the file changes, so the production renewal hook and the local job feed the same mechanism.

### Nginx responsibilities

- Runs the official image's **mainline** line (odd minor, `1.31.x-alpine`), not stable: nginx itself recommends mainline, fixes land there first, and the image is rebuilt and scanned like every other pin ([0018](0018-owasp-security-baseline.md)). Decided 2026-10-01, when the update moved it from 1.30.5.

- Terminates TLS; TLS 1.2 and 1.3 only. The TLS 1.2 suites are Mozilla's "intermediate" set, ECDHE with AEAD only; nginx's default list also offered CBC and SHA-1 suites (decided 2026-10-02).
- Refuses every name it does not serve: the default HTTPS server rejects the TLS handshake for an unknown name, and answers `421 Misdirected Request` to a request whose `Host` names no virtual host after a handshake for one that does (decided 2026-10-02).
- Listens for plain HTTP only to redirect: each virtual host has a companion server on the HTTP port (`NGINX_HTTP_PORT`; locally `127.0.0.1:8080`, in production 80) that answers `301` to `https://` and the matched name (`$server_name`, never the request's `Host`) on the public port; a request for any other name is closed without an answer. A typed `http://` address then reaches the application instead of failing (decided 2026-10-02).
- Drops slow clients instead of holding their connections: 10 s between two reads of a request's headers or body, 30 s between two writes of a response, 15 s for an idle keep-alive connection, and at most 256 concurrent requests per client address, answered `429` above that. The gaps are between reads or writes, so uploads and downloads of any length are unaffected, and WebSocket and server-sent event streams keep their own read timeouts. The per-address bound is generous because locally every browser is one address (below); the application's rate limits stay in the API ([0010](0010-sessions-postgres-ratelimits-valkey.md)). Decided 2026-10-02.
- Serves the built frontend bundle, which is part of the `nginx` image, with the SPA history fallback; hashed assets cached immutably and `index.html` not cached. Under the `dev` profile, proxies to the Vite dev server instead ([0014](0014-frontend-quasar-vue.md)).
- Proxies `/api` to the API and upgrades `/api/socket.io` to WebSocket, with an idle timeout longer than the Socket.io ping interval.
- Locally, serves the IdP under its own host name so the browser can complete the SAML redirect ([0008](0008-authentication-saml2-ldap.md)). This virtual host is disabled in production, where the IdP is external: its host name reaches the container only as an interpolated local value, like the e2e origin's (below), so the production units carry none.
- Locally, serves Dozzle ([0002](0002-service-inventory-and-networks.md)) under its own host name, unbuffered so its server-sent event streams stay live. It is a developer convenience with no production counterpart and no login of its own, so its host name too is an interpolated local value that never reaches the production units, and the virtual host is removed when its host name is unset. It gets the base headers but not the application's CSP, Permissions-Policy or COOP (below).
- Sets `X-Forwarded-For` and `X-Forwarded-Proto`, replacing any value the client sent; the API trusts these only from the proxy address, which is what makes the IP-keyed rate limits in [0010](0010-sessions-postgres-ratelimits-valkey.md) meaningful.
- That in turn requires Nginx to see the real client address. **Rootless Podman's default port publishing (`rootlessport`) does not preserve it**: locally, every request from the host reaches Nginx from Nginx's own container address, so all local browser traffic shares one rate-limit key. That is harmless on a developer machine, but on the production host it would make every visitor share one limit. The production host must therefore publish Nginx's port in a way that preserves source addresses (for example pasta port forwarding or host networking for Nginx), and this is verified when that host is set up. Clients inside the container networks, such as the e2e browser, already arrive with their own address.
- Sends the base headers on **every** virtual host, the third-party UIs included (`base-headers.conf`): `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin` unless the upstream sends a Referrer-Policy of its own, which is kept (Keycloak, NetBox and Mailpit send stricter ones). A proxied UI's own HSTS and `nosniff` are hidden, so each response carries one of each. None of the three depends on what a page is; the CSP, Permissions-Policy and COOP do, and stay on the application's virtual hosts only, because they are written for the application, not for a third-party UI. Decided 2026-10-02; until then the third-party virtual hosts got no headers from Nginx at all.
- Sends the rest of the security headers in [0018](0018-owasp-security-baseline.md) on the application's virtual hosts, including the CSP. The CSP's WebSocket source is the matched virtual host's own name (`$server_name`, never the request's `Host`), so every origin that serves the application allows its own socket only.
- Locally and in CI, serves the application a second time under `e2e.localhost`, proxied to `api-e2e`, the end-to-end suite's api on its own database ([0015](0015-testing-vitest-playwright.md)). Both virtual hosts include the same locations. The e2e host name reaches the container only as an interpolated local value, so the production units carry no such virtual host.
- Enforces a request body size **ceiling** as deployment configuration. The upload size limit is a runtime setting validated to stay below this ceiling ([0020](0020-object-storage-uploads.md)).
- Serves Grafana under its own host name in every environment, and locally Mailpit's inbox, proxying to both over TLS verified against the CA root ([0022](0022-observability-and-alerting.md)). Like Dozzle, both get the base headers but not the application's; Mailpit's host name is an interpolated local value, and a virtual host is removed when its host name is unset.
- Serves NetBox ([0031](0031-netbox-locations.md)) under its own host name in every environment, the same way: TLS to its Granian listener, verified, with the base headers and without the application's.
- Sends `$request_id` to the API as `X-Request-Id` and writes it into its access log, so a request correlates across both ([0021](0021-structured-logging.md)).
- Keeps the IdP's POST to the SAML ACS in memory (a 128 KB body buffer on that location only): the encrypted assertion is larger than the default 16 KB, and would otherwise be written to a temporary file on every login.
- Routes `GET /api/ping` like any API path. Health, readiness and metrics are on the API's internal port and are never routed ([0022](0022-observability-and-alerting.md)).
- Resolves every upstream by container name at request time, so Nginx starts without its upstreams and follows a container that comes back on a new address, as a restarted container does under Podman. Resolved addresses are cached for **1 s**, and a connect to an upstream times out after **2 s** instead of the default 60 s: without both, a Socket.IO client reconnecting right after `podman stop api && podman start api` went to the old address for up to 10 s, and that attempt hung until the client gave up at 20 s. The setting applies to every virtual host, and a connect on the container network takes well under a millisecond.
- Stops within Podman's 10-second stop timeout: on its stop signal (SIGQUIT, a graceful shutdown) Nginx gives open connections **5 seconds**, the API's grace period ([0006](0006-feathersjs-typescript-api.md)), then closes them. Without the bound a WebSocket held Nginx open until Podman sent SIGKILL.

The API is mounted under the `/api` prefix so Feathers service paths cannot collide with SPA routes.

### One configuration, not two

There is a single Nginx configuration, parameterised by environment (server names, certificate path, ports, upstream addresses, whether the IdP, Dozzle, Mailpit and e2e virtual hosts are enabled). Production-specific concerns that belong to the institution — DNS, the public address, the ACME endpoint — are configuration values, not a separate config file.

## Consequences

- TLS, cookie behaviour, SAML redirects and security headers are exercised identically from the first local run.
- Certificate issuance itself is not exercised before production. This is accepted: issuance is a configuration of an off-the-shelf ACME client, and its failure mode is visible (Nginx keeps the last valid certificate and the expiry is monitored).
- Each developer imports one root certificate into their browser once.
- HSTS carries `includeSubDomains` on every host Nginx serves, so a browser that has visited the application's host refuses plain HTTP for every name below it for a year. A subdomain of the production application host that cannot serve HTTPS cannot exist.
- The TLS 1.2 suite list excludes clients without ECDHE and AES-GCM or ChaCha20 (in practice nothing still supported); a client that needs a CBC suite cannot connect.

## Open questions

- Where production certificates for the **internal** TLS listeners come from — OpenBao ([0023](0023-secrets-management.md)), PgBouncer and PostgreSQL ([0004](0004-pgbouncer-pools.md)). The institutional ACME CA cannot issue for internal names such as `openbao` or `postgres`, so production needs a private issuing CA. Decide together with the production host, which is itself deferred ([README](README.md)).
