# 0018: OWASP-aligned security baseline

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0031, 0068
- Related: [0005](0005-typebox-schema-boundary.md), [0008](0008-authentication-saml2-ldap.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0016](0016-nginx-and-tls-everywhere.md), [0020](0020-object-storage-uploads.md), [0023](0023-secrets-management.md)

## Context

This system holds identifiable data about university members behind a university login. Security is a requirement of the design rather than a review step at the end, so the controls are mapped to the OWASP Top 10 and each one is owned by a specific decision elsewhere in this set.

## Decision

| OWASP category | Controls in this system |
| --- | --- |
| A01 Broken access control | Default-deny authorization hook on every service; per-request session and role validation ([0010](0010-sessions-postgres-ratelimits-valkey.md)); CASL conditions pushed into queries so scoping is not per-service discipline; channel filtering mirrors the same ability ([0012](0012-role-scoped-channels.md)); object bytes reachable only through an authorized API call, never directly from the object store ([0020](0020-object-storage-uploads.md)) |
| A02 Cryptographic failures | TLS in every environment ([0016](0016-nginx-and-tls-everywhere.md)); argon2id for the single stored password; refresh tokens stored only as hashes; secrets held in OpenBao, delivered per service into tmpfs by an agent, never written to disk in plaintext or passed as environment variables ([0023](0023-secrets-management.md)) |
| A03 Injection | Knex parameter binding, no SQL string concatenation; `additionalProperties: false` on every schema ([0005](0005-typebox-schema-boundary.md)); **LDAP filter escaping** for every directory lookup filter built from user input ([0008](0008-authentication-saml2-ldap.md)); CSP restricting script sources; uploaded files served as attachments with `nosniff` and server-generated keys, with only allowlisted raster images served inline and never SVG, so an upload cannot become stored XSS or a path traversal ([0020](0020-object-storage-uploads.md)) |
| A04 Insecure design | SAML2 means the application never handles university credentials ([0008](0008-authentication-saml2-ldap.md)); the break-glass account is the single audited exception; surrogate keys make erasure possible ([0013](0013-gdpr-export-and-retention.md)) |
| A05 Security misconfiguration | One stack in every environment ([0001](0001-one-stack-every-environment.md)); configuration validated at startup with the process refusing to start otherwise; no debug modes or seeded demo accounts in production |
| A06 Vulnerable components | Pinned base images by digest; lockfile installs; automated dependency update PRs; `pnpm audit` and an image vulnerability scan as CI checks |
| A07 Authentication failures | Fail-closed rate limits keyed by account **and** IP together ([0010](0010-sessions-postgres-ratelimits-valkey.md)); refresh rotation with family revocation on reuse; immediate revocation on logout, disable and role change; generic authentication failure messages |
| A08 Data integrity failures | Full SAML assertion validation including signature scope, audience, recipient, timestamps, `InResponseTo` and replay cache ([0008](0008-authentication-saml2-ldap.md)); signed lockfile and pinned digests in the build |
| A09 Logging and monitoring failures | Structured logs with redaction configured centrally ([0021](0021-structured-logging.md)); audit events for authentication, role change, export and administrative action; alerts on error rates and authentication anomalies delivered by email ([0022](0022-observability-and-alerting.md)); retention fixed by configuration ([0013](0013-gdpr-export-and-retention.md)) |
| A10 Server-side request forgery | The application makes no outbound request to a user-supplied address. Its only outbound endpoints are the IdP, the LDAP directory and the SMTP relay, all from configuration. If that changes, an allowlist is required |

### Response headers

Set by Nginx ([0016](0016-nginx-and-tls-everywhere.md)) so they apply to every response including error pages:

- `Content-Security-Policy` with no `unsafe-eval`; `connect-src` covering the API origin and `wss:`; `frame-ancestors 'none'`
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`

### Cross-origin and CSRF

Frontend and API share one origin behind Nginx, so CORS is not needed in production. The refresh cookie is `SameSite=Strict` and the refresh endpoint additionally validates the `Origin` header against the configured frontend origin and rejects requests without one. Allowed origins are an explicit per-environment list shared between the CORS configuration and that check.

### Practices

- Rendering user-supplied HTML is prohibited; `vue/no-v-html` is enabled as a lint error rather than a guideline.
- Dependency and image scanning are CI gates. Because images are rebuilt for each release, a security patch reaches production through a normal release.
  - `pnpm audit` blocks at **high** severity and above.
  - Trivy scans every image `compose.yaml` names, built or pinned, and blocks on **HIGH or CRITICAL findings that have a fix**. Unfixed findings are reported but do not block, because nobody can act on them and a permanently red gate stops being read. A finding that is accepted instead of fixed goes into `.trivyignore.yaml`, scoped to the package it concerns, with a statement and an expiry after which it blocks again. The one file not scanned is `gosu` in the PostgreSQL image: it only drops root privileges at container start, and its Go standard library findings concern code it never runs.
  - Images built here run `apk upgrade` (Alpine) at build time, and Node images drop the bundled npm, which nothing uses (pnpm comes through corepack) and which only brings its own findings along.
  - A vulnerable transitive dependency whose parent has not caught up is raised by a pnpm `overrides` floor in `pnpm-workspace.yaml`, with a comment saying when to remove it. The first was `@xmldom/xmldom` below 0.8.15 under the SAML libraries, which the audit gate found on its first run.
- Dependency update PRs come from **Renovate** (`renovate.json`), which also keeps the digest-pinned images current, including the version comments that `compose.yaml` carries instead of tags. It becomes active once the repository is hosted with the Renovate app installed.
- The authorization matrix in [0011](0011-casl-role-authorization.md) is the specification for authorization tests, including negative cases for every denied cell.

## Consequences

- Several controls are enforced by tests and lint rules rather than review, which is what keeps them true as the code grows.
- A strict CSP constrains which UI libraries can be used; Quasar is compatible but any addition needs checking.
- Security work is distributed across the ADRs rather than centralised, so this document is a map, not an implementation.
- No penetration test is required before production. The controls above are verified by the test suite and CI gates.
