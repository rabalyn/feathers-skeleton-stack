# Authentication and requests

Illustrates [0008](../0008-authentication-saml2-ldap.md), [0010](../0010-sessions-postgres-ratelimits-valkey.md), [0011](../0011-casl-role-authorization.md), [0012](../0012-role-scoped-channels.md) and [0029](../0029-api-tokens.md). Where this page and an ADR or the code disagree, the ADR and the code win.

Every request from the browser goes through `nginx :8443`; it is left out of the arrows below unless it does something itself. PostgreSQL is always reached through PgBouncer.

## SAML2 login

Locally the IdP is Keycloak behind `idp.localhost`, federating the `ldap` container; in production it is the university IdP. The application code is identical.

```mermaid
sequenceDiagram
  autonumber
  actor b as Browser
  participant ngx as nginx
  participant api
  participant vk as valkey
  participant pg as postgres (via pgbouncer)
  participant idp as idp (Keycloak)
  participant ldap

  b->>ngx: GET /api/auth/saml/login?returnTo=/documents
  ngx->>api: proxied, X-Forwarded-For set
  api->>vk: rate limit samlLogin (per client IP)
  api->>pg: store AuthnRequest ID + returnTo, with expiry
  api-->>b: 302 to IdP SSO URL, signed AuthnRequest

  b->>idp: via nginx idp vhost
  idp->>ldap: LDAPS :636 bind as the user
  idp-->>b: auto-POST form, signed and encrypted assertion

  b->>ngx: POST /api/auth/saml/acs
  ngx->>api: proxied (128 KB in-memory body buffer)
  api->>vk: rate limit samlAcs (per client IP)
  api->>api: decrypt with SP key, verify signature against configured IdP cert,<br>Issuer, Audience, Destination, NotBefore/NotOnOrAfter
  api->>pg: DELETE … RETURNING the request ID (InResponseTo, atomic)
  api->>pg: insert assertion ID (replay cache, unique)
  api->>pg: upsert user by TU-ID (cn), default role on first login
  alt account disabled, or maintenance mode without bypass
    api->>pg: audit login.refused
    api-->>b: 403, or 303 to the maintenance page
  else
    api->>pg: insert auth_sessions row + first refresh token hash, audit "login"
    api-->>b: 303 to returnTo (same-origin path only)<br>Set-Cookie refresh token: HttpOnly, Secure, SameSite=Strict,<br>Path=/api/authentication
  end

  b->>api: POST /api/authentication {strategy: refresh} + cookie
  api-->>b: access token (JWT, 15 min, in memory only)<br>+ rotated refresh cookie
```

## Authenticated REST call and WebSocket

Every authenticated request, REST or WebSocket, re-reads the session row and the user's permissions, so logout, disabling an account and role changes take effect on the next request.

```mermaid
sequenceDiagram
  autonumber
  actor b as Browser (SPA)
  participant ngx as nginx
  participant api
  participant pg as postgres (via pgbouncer)

  b->>ngx: wss://…/api/socket.io (upgrade)
  ngx->>api: HTTP :3030, upgraded
  b->>api: authenticate with the access token
  api->>pg: session by id (not revoked, not expired, user enabled)
  api->>pg: roles → permissions → CASL ability
  api->>api: join channels the ability allows

  b->>api: documents.find (socket) or GET /api/documents (REST, Bearer)
  api->>pg: session + ability again, for this request
  api->>api: default-deny hook, CASL rule → query filter
  api->>pg: SELECT … scoped by the ability
  api-->>b: result

  Note over api,b: A write by anyone publishes created / patched / removed<br>to the channels whose ability may read the record.
```

## Refresh, rotation and reuse

```mermaid
sequenceDiagram
  autonumber
  participant tab as Browser tab
  participant lock as navigator.locks
  participant api
  participant vk as valkey
  participant pg as postgres (via pgbouncer)

  tab->>lock: request "refresh" lock (serialises tabs)
  tab->>api: POST /api/authentication {strategy: refresh} + cookie
  api->>vk: rate limit refresh (per client IP)
  api->>pg: lock session row, find token hash in the family
  alt current token
    api->>pg: mark it rotated, successor = HMAC(refresh key, token),<br>store only its SHA-256
    api-->>tab: new access token, Set-Cookie successor
  else rotated, within the grace window
    api->>api: follow the HMAC chain to the current token
    api-->>tab: same current token as the first answer
  else rotated, outside the grace window
    api->>pg: revoke the whole family, audit reuse
    api-->>tab: 401, the tab returns to login
  end
  tab->>lock: release
```

## API tokens and break-glass

Two other ways in, both REST only:

```mermaid
flowchart LR
  script(["Script"]) -->|"Authorization: Bearer &lt;api token&gt;<br>REST only, no session"| api
  admin(["Administrator<br>/break-glass route"]) -->|"POST /api/authentication<br>{strategy: password}"| api

  api -->|"token row + owner's permissions,<br>every request"| pg[("postgres<br>api_tokens")]
  api -->|"argon2id check, rate limit<br>per account + IP"| lc[("postgres<br>local_credentials")]
  api -->|"session issued like the ACS"| sess[("postgres<br>auth_sessions")]
  api -. "every attempt logged at warn → Loki,<br>Grafana alerts on every success<br>and on > 3 failures in 10 min" .-> loki["loki"]
```
