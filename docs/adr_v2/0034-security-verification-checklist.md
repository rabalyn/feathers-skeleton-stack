# 0034: Security verification checklist for new features

- Status: Accepted
- Date: 2026-10-02
- Scope: Required (v1)
- Related: [0005](0005-typebox-schema-boundary.md), [0008](0008-authentication-saml2-ldap.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0013](0013-gdpr-export-and-retention.md), [0016](0016-nginx-and-tls-everywhere.md), [0018](0018-owasp-security-baseline.md), [0020](0020-object-storage-uploads.md), [0021](0021-structured-logging.md), [0029](0029-api-tokens.md), [0030](0030-service-generator.md)

## Context

[0018](0018-owasp-security-baseline.md) is a map: it says which decision owns each OWASP category, and it states that "no penetration test is required before production" because the controls are held by the test suite and CI gates. That holds only while new code keeps using those controls. The controls are structural — a default-deny hook on every service, CASL conditions compiled into queries, `additionalProperties: false` on every schema, one error-sanitising layer — so the usual way to regress is not to disable a control but to write a feature that quietly steps around it: a service with a hand-written query that ignores the ability, a schema that allows a client to set `ownerId`, an endpoint that makes an outbound request to a value from the request, a template or a field that reaches the browser unescaped.

A later agent adding a feature cannot re-derive all of this from the code each time, and a full manual pentest on every change is not affordable. What is affordable, and what this ADR fixes, is a fixed checklist of what to verify and how, so the same ground is covered the same way every time, by whoever does the work.

This was written after a review that exercised the running stack against the OWASP Top 10 and found the controls intact; the checklist is that review's route, turned into a standing procedure rather than a one-off.

## Decision

A change that adds or alters a service, a route, an authorization rule, an outbound call, a template, or anything that renders user input is not done until the items below that apply to it are verified, **by a test in the suite wherever a test can express it** ([0015](0015-testing-vitest-playwright.md)), not by inspection alone. The authorization matrix in [0011](0011-casl-role-authorization.md) remains the specification for authorization tests, including a negative case for every denied cell; this checklist is the rest of the surface around it.

Each item names the control and the decision that owns it. If an item cannot be satisfied, the gap is raised before merge (the CLAUDE.md working rule), not worked around.

### Access control (A01)

- Every externally reachable service is authenticated and authorized by the default-deny hook, or is on the `PUBLIC_SERVICES` allowlist by an explicit decision ([0011](0011-casl-role-authorization.md)). A new service added with `pnpm gen:service` ([0030](0030-service-generator.md)) inherits this; a hand-registered route does not — check it.
- Scoping is expressed as CASL conditions, not as per-service query code, so the ability decides. Verify cross-tenant access fails as a **negative test**: a user who may read only their own rows gets an empty result or a 404 (worded like a missing id, not "forbidden") for `get` by id; a 404 for `update`, `patch` and `remove` of another owner's id; no row touched by a multi-row `patch(null, …)` or `remove(null, …)` whose query aims at another owner's rows; and an empty result for `find` with `$or`, `$in`, `$ne`, `$select` and `$sort` aimed at them.
- No client-settable field decides ownership or privilege. `ownerId`, `userId`, `id`, `createdAt`, role and enabled-state fields are set by the server, and the data schema rejects them (`additionalProperties: false`, [0005](0005-typebox-schema-boundary.md)). Test a create/patch that tries to set each.
- No field the caller may not see leaves the api. The external resolver strips it ([0005](0005-typebox-schema-boundary.md), [0011](0011-casl-role-authorization.md)): password material, token and session hashes, object storage keys, another user's restricted fields. Test that a REST result, and one whose `$select` names the field outright, does not carry it.
- A new service paginates with `PAGINATE` (`apps/api/src/paginate.ts`) or a lower bound and never turns pagination off ([0005](0005-typebox-schema-boundary.md)); a `$limit` above the maximum is answered with the maximum, not with the table.
- Real-time: a new service names a publisher ([0012](0012-role-scoped-channels.md)). If it publishes, the channel filter drops what a connection may not read — assert an event does **not** reach an unauthorized connection, and that field-level rules hold in the payload as they do in the REST result.

### Authentication and session integrity (A02, A07)

- New authentication or session code keeps: tokens re-checked against the session row every request; revocation on logout, disable and role change; refresh rotation with family revocation on reuse; generic failure messages in the application's own words ([0008](0008-authentication-saml2-ldap.md), [0010](0010-sessions-postgres-ratelimits-valkey.md)). An access token must stop working the instant its session is revoked — test it.
- A new authentication entry point that sets or reads the refresh cookie also enforces the `Origin` check and a fail-closed rate limit keyed by account **and** IP ([0010](0010-sessions-postgres-ratelimits-valkey.md), [0018](0018-owasp-security-baseline.md)).
- An endpoint that is costly or can be turned against someone else — it sends mail, starts an export or another job, stores an upload, or makes an outbound call — has a per-user rate-limit bucket, or a stated reason why not ([0010](0010-sessions-postgres-ratelimits-valkey.md)). Test that the request over the limit gets a `429` and that a Valkey outage refuses it.
- An API token never gains what its owner lacks, never carries an excluded permission, and is bounded on every request by the owner's current rights ([0029](0029-api-tokens.md)). A new permission is classified as token-grantable or not, with a reason.

### Injection and rendering (A03)

- Queries go through Knex binding; no SQL is built by string concatenation. A directory or other external-store filter built from user input is escaped (LDAP: `escapeFilter`, [0008](0008-authentication-saml2-ldap.md)).
- Anything that renders user input escapes it. In the browser, `vue/no-v-html` stays a lint error ([0018](0018-owasp-security-baseline.md)). In mail, the Liquid sandbox and output escaping stand: strict variables and filters, no partials, same-origin links, Markdown with raw HTML off ([0027](0027-email-templates-and-sending.md)); a new mail kind or filter is tested against `<script>`, an unknown variable, and an off-origin link.
- An upload accepts only allowlisted types verified by magic bytes, is served with `nosniff`, a server-generated key and a disposition that is `attachment` unless it is a verified raster image, never SVG ([0020](0020-object-storage-uploads.md)). A new accepted type is justified against this.

### Response headers (A05)

- The `Content-Security-Policy` is scoped per response and no response carries two ([0018](0018-owasp-security-baseline.md)): the document policy on the SPA's documents and its static bundle, `default-src 'none'; sandbox` on file bytes, none on API JSON. Any location that sets an `add_header` of its own discards every inherited header and must include `security-headers.conf` again, and a new HTML-serving location also gets `document-csp.conf`; a new virtual host includes `base-headers.conf` at least ([0016](0016-nginx-and-tls-everywhere.md)) and its own HTTP redirect server; a new API response that must restrict rendering sets its own policy and Nginx adds none to `/api/`. `e2e/tests/headers.spec.ts` asserts each header exactly once, through Nginx, on a document, an asset, API JSON, file bytes and the third-party virtual hosts; a header change or a new kind of response extends it.
- Configuration is validated at startup and the process refuses to start otherwise; no debug mode or seeded demo account reaches production ([0018](0018-owasp-security-baseline.md)). A new config field is validated in `config.ts`, and a secret is read only from its `<NAME>_FILE` path ([0023](0023-secrets-management.md)), never a plain environment variable.

### Error handling and disclosure (A05, A07, A09)

- A new error path keeps the sanitising contract ([0018](0018-owasp-security-baseline.md)): unexpected errors are logged in full and answered `500 Internal error`; expected 4xx/503 keep their status and the application's own wording and lose anything a library added; a schema refusal is a 400 naming the fields only; a 401 says one of the fixed messages. A new audit-worthy action records an audit event ([0013](0013-gdpr-export-and-retention.md)).

### Outbound requests (A10)

- The application makes no outbound request to a user-supplied address. A new outbound call goes to a configured endpoint or a fixed in-code allowlist, follows no redirect off it, and is switchable off if it is periodic ([0018](0018-owasp-security-baseline.md), [0032](0032-system-info-and-update-check.md)).

### Logging, privacy and retention (A09)

- A new secret-bearing field, header or parameter is covered by the logger's redaction (`redactPaths`, `apps/api/src/logger.ts`, [0021](0021-structured-logging.md)), and a test logs a request carrying it and finds `[redacted]` in its place. Personal data in a log line is the surrogate user key, never the TU-ID.
- New personal data is registered so it is exported and erased, and its retention is a runtime setting, not a constant ([0013](0013-gdpr-export-and-retention.md)). The registry's schema test covers the new field.

### Dependencies and secrets (A02, A06)

- `pnpm audit` (high and above) and the Trivy image scan stay green, or a finding is accepted in `.trivyignore.yaml` with a statement and an expiry; `gitleaks` finds no secret ([0018](0018-owasp-security-baseline.md)). A new image is digest-pinned and reaches the Quadlet and inventory generators.

## Consequences

- Adding a feature now carries a fixed, repeatable security step that is mostly expressed as tests, so a regression is caught by CI rather than by the next review.
- The checklist will drift from the code if a control changes and this list is not updated with it. The rule is the same as for any ADR: a change that alters a control edits the owning ADR and, where the control appears here, this one, in the same change.
- This is a skeleton. A product built on it adds its own resources and will add items here for surfaces this set does not have yet (a payment flow, a public API, server-rendered pages). The structure — each item names a control and an owning decision, and is backed by a negative test — is what a product extends.
- It remains true that no separate penetration test is required before production ([0018](0018-owasp-security-baseline.md)); this ADR is what keeps that claim honest as the code grows.
