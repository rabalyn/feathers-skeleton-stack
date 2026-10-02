# Architecture Decision Records (v2)

This directory holds the architecture decisions for this project. It supersedes `docs/adr/`, which split a single planning document into seventy files and accumulated 433 open items before any business logic existed. See [0019](0019-adr-convention.md) for what changed and why.

Thirty-four ADRs, each covering a decision with real alternatives. Read [0001](0001-one-stack-every-environment.md) first — the parity rule it sets is the reason several later decisions look the way they do.

## Index

### Foundation

- [0001 — One containerized stack in every environment](0001-one-stack-every-environment.md)
- [0002 — Service inventory and network segmentation](0002-service-inventory-and-networks.md)

### Data layer

- [0003 — PostgreSQL as system of record, Knex as query builder, no ORM](0003-postgresql-and-knex.md)
- [0004 — PgBouncer in transaction mode for all pooled access; direct connections only for migrations and backup](0004-pgbouncer-pools.md)
- [0005 — TypeBox schemas enforced at the Feathers service boundary](0005-typebox-schema-boundary.md)
- [0020 — S3-compatible object storage with immutable keys and soft deletion](0020-object-storage-uploads.md)

### Application

- [0006 — FeathersJS v5 API in TypeScript on Koa, WebSocket-only real-time](0006-feathersjs-typescript-api.md)
- [0007 — The typed client is exported from the API package](0007-typed-client-from-api.md)
- [0014 — Frontend with Vue 3, Quasar and feathers-pinia](0014-frontend-quasar-vue.md)
- [0024 — Background jobs on BullMQ in a dedicated worker container](0024-background-jobs-bullmq.md)
- [0025 — Operational settings are runtime settings in PostgreSQL](0025-runtime-settings.md)
- [0027 — E-mail from code-declared mail kinds, with admin-edited Liquid templates, sent by the worker](0027-email-templates-and-sending.md)
- [0031 — NetBox holds the university's locations, seeded from its published building list](0031-netbox-locations.md)
- [0032 — A system-info page shows what runs and which updates are out, from a daily check](0032-system-info-and-update-check.md)
- [0033 — Feature branches are deleted once merged, on GitHub and locally](0033-branches-and-pull-requests.md)

### Identity, access and privacy

- [0008 — Authentication via SAML2, with a local IdP container and a break-glass superadmin](0008-authentication-saml2-ldap.md)
- [0009 — TU-ID is the user-facing identifier; a surrogate key is the internal one](0009-tu-id-identity-model.md)
- [0010 — Sessions in PostgreSQL, validated per request; rate limits in Valkey](0010-sessions-postgres-ratelimits-valkey.md)
- [0011 — Role-based authorization with feathers-casl and a default-deny boundary](0011-casl-role-authorization.md)
- [0012 — Real-time updates through ability-scoped Feathers channels](0012-role-scoped-channels.md)
- [0013 — GDPR data export, retention as runtime settings, and erasure semantics](0013-gdpr-export-and-retention.md)
- [0028 — Read-only view-as another user, bounded by the viewer's own rights](0028-read-only-view-as.md)
- [0029 — API tokens for scripts, owned by a person and bounded by their rights](0029-api-tokens.md)
- [0018 — OWASP-aligned security baseline](0018-owasp-security-baseline.md)

### Operations

- [0015 — Vitest for unit and integration tests, Playwright for browser end-to-end](0015-testing-vitest-playwright.md)
- [0016 — Nginx reverse proxy with real TLS in every environment](0016-nginx-and-tls-everywhere.md)
- [0017 — Restic backups to an NFS target, with the restore path tested in CI](0017-nfs-backup-storage.md)
- [0021 — Structured JSON log files, GDPR-constrained, shipped to Loki](0021-structured-logging.md)
- [0022 — Prometheus, Loki and Grafana, with email alerting and an external uptime check](0022-observability-and-alerting.md)
- [0023 — Secrets in OpenBao, delivered per service as files in tmpfs](0023-secrets-management.md)
- [0026 — MCP servers as local development tooling, not a product surface](0026-mcp-development-tooling.md)

### Process

- [0019 — ADR convention for this directory](0019-adr-convention.md)
- [0030 — New services are scaffolded by a project-local generator](0030-service-generator.md)
- [0034 — Security verification checklist for new features](0034-security-verification-checklist.md)

### Diagrams

[`diagrams/`](diagrams/README.md) draws the stack's topology (services, ports, networks) and its main data flows in Mermaid. The diagrams illustrate these ADRs and decide nothing ([0019](0019-adr-convention.md#diagrams)).

## Not yet decided

Covered in v1 but not carried forward, or deliberately deferred. Listed so nothing is lost by silence, not because they are all needed soon.

| Topic | Status |
| --- | --- |
| Release procedure, rollback, image build and registry | Deferred. Needed before the first production deployment |
| Production host, firewall | Deferred until a host exists. Must publish Nginx so that client source addresses survive, which rootless Podman's default port publishing does not ([0016](0016-nginx-and-tls-everywhere.md)). Must set `vm.overcommit_memory=1`: Valkey forks for its RDB snapshot and AOF rewrite, and without overcommit that fork can fail with memory to spare, silently stopping persistence ([0010](0010-sessions-postgres-ratelimits-valkey.md)); Valkey warns about it at every start |
| Off-site backup copy | Accepted risk for now ([0017](0017-nfs-backup-storage.md)) |
| Distributed tracing | Deferred; `request_id` correlation is in place and should stay `traceparent`-compatible ([0021](0021-structured-logging.md)) |
| Multi-host scale-out | Deferred, as in v1 |
| Offering a product's own services over MCP | Left to each product; the skeleton uses MCP for local development tooling only ([0026](0026-mcp-development-tooling.md)) |

## Implementation slices

The architecture is built in thin vertical slices, riskiest parts first (see `CLAUDE.md`). This section records what exists and what comes next; the decisions themselves stay in the ADRs.

**Slice 1 — done.** Nginx with the local CA, the API, PgBouncer and PostgreSQL, OpenBao with one agent per consuming service, the `users` service with CASL default-deny, SAML2 login through Keycloak and LDAP, sessions validated per request, Vitest with per-worker databases, Playwright, and Quadlet generation with a drift check. `scripts/stack.sh up`, `test` and `e2e` run it; `reset` gives a cold start.

**Slice 2 — done.** Deferred from slice 1 by decision, and needed before production.

- Refresh token rotation, reuse detection and the grace window ([0010](0010-sessions-postgres-ratelimits-valkey.md))
- The `settings` table, its seeding, and the refuse-to-start check; session lifetimes and rate limits are settings ([0025](0025-runtime-settings.md)); a minimal `audit_events` table ([0013](0013-gdpr-export-and-retention.md))
- Valkey, with fail-closed rate limits on the SAML login start, the ACS and refresh ([0010](0010-sessions-postgres-ratelimits-valkey.md)), and trusting `X-Forwarded-For` only from Nginx
- LDAP directory lookup from the API, with its service account ([0008](0008-authentication-saml2-ldap.md))
- The CI gate `scripts/ci.sh` ([0015](0015-testing-vitest-playwright.md)), lint including the client dependency boundary ([0007](0007-typed-client-from-api.md)), `gitleaks` ([0023](0023-secrets-management.md)), and the audit and image scan gates with Renovate ([0018](0018-owasp-security-baseline.md)). The hosted workflow that calls the script waits for a remote
- The Quasar frontend ([0014](0014-frontend-quasar-vue.md)): SAML login, session restore with the access token in memory only, own profile, logout, de/en, and screens for users (role, enable), runtime settings and directory lookup, with actions hidden by the shared CASL abilities. `createClient()` in the API's client entry point ([0007](0007-typed-client-from-api.md)); `feathers-pinia` as a vendored fork; the bundle built into the Nginx image and the Vite dev server under `up --dev`. The end-to-end suite runs on the real UI, including role-based visibility

**Slice 3 — done.**

- Real-time channels ([0012](0012-role-scoped-channels.md)): publishers for the existing services, membership from the session's role, forced re-authentication when a role, the account state or the session changes, and the end-to-end test of an update arriving over the WebSocket. Settings became admin-only on the way ([0011](0011-casl-role-authorization.md))
- The contract step of refresh rotation: `auth_sessions.refresh_token_hash`, `rotated_at` and `family_id` are dropped ([0003](0003-postgresql-and-knex.md) expand and contract)
- The worker container and BullMQ ([0024](0024-background-jobs-bullmq.md)), which the GDPR export and uploads build on: its own database login and Valkey user (every service now has one), the maintenance queue with retention cleanup daily at 03:30, and `/health/live`. Export expiry and object purge arrive with their features

**Slice 4 — observability** ([0021](0021-structured-logging.md), [0022](0022-observability-and-alerting.md)): request ids and one line per request, rotated JSON log files, metrics from the API and the worker; the API's readiness on PostgreSQL and Valkey; Prometheus, Loki, Grafana Alloy (Promtail is end of life), Grafana with dashboards and alert rules as code, Mailpit, the exporters, and blackbox_exporter as the uptime check (Uptime Kuma cannot be provisioned from files); TLS on every observability hop; the alert delivery check in CI. The newest Grafana and four exporter images carry HIGH findings fixed upstream but not yet released; they are accepted in `.trivyignore.yaml` until 2026-10-25, before the first production release ([0018](0018-owasp-security-baseline.md)).

**Slice 5 — break-glass and bootstrap** ([0008](0008-authentication-saml2-ldap.md), [0023](0023-secrets-management.md)): the break-glass account with its argon2id password, the `password` login limited per account and client IP, its audit events and alert, and the unlinked `/break-glass` page; the bootstrap command in the api container that creates the account or rotates its password; and `scripts/openbao.sh`, the production OpenBao procedure (init with one key share, userpass administrators, generated internal values, `set` for external ones, unseal and re-issue), tested in CI against a throwaway OpenBao. Runtime settings stay seeded by `migrate` ([0025](0025-runtime-settings.md)). A first production start is: OpenBao `init`, the external values with `set`, `migrate`, then the bootstrap command.

**Slice 6 — object storage and uploads** ([0020](0020-object-storage-uploads.md)), chosen before backups so the first backup covers objects too: Garage v2.4.1 behind Nginx for TLS in one `s3` image, with a key per client; the `files` table and `POST /api/files` (allowlist, magic bytes, size and quotas before a byte is stored, streamed and hashed), `file-contents` downloads with `nosniff` and a sandbox CSP, documents with their file, the own avatar through `avatars`; soft deletion and the daily object purge in the worker; the documents page and the profile picture in the UI, with Vitest and Playwright over the real Garage.

**Slice 7 — backups** ([0017](0017-nfs-backup-storage.md)): the `backup` container, a Node entry of the api's code base with restic and `pg_dump` 18 in its own image and a UID of its own, scheduled from the runtime settings; the `db`, `objects` (through a mirror of the bucket) and `state` (Valkey's RDB, OpenBao's raft snapshot) repositories with daily retention; repositories made only by an explicit `init`, and every run refused on a missing, empty or read-only target; PostgreSQL roles re-applied on every start, which brought the read-only `backup` role to existing clusters ([0003](0003-postgresql-and-knex.md)); `scripts/backup.sh`, the restore procedure, with the session revocation post-step; `scripts/backup-test.sh`, the backup-and-restore cycle in CI; `scripts/ci-nfs-runner.sh` for the gate on real NFS; the two backup alerts ([0022](0022-observability-and-alerting.md)).

**Slice 8 — GDPR export and erasure** ([0013](0013-gdpr-export-and-retention.md)): the personal data registry with its schema test; exports as ZIPs of `export.json` and the person's files, built by the worker on a `data-exports` queue and relayed to the requester's browser through the channels, which settled how worker results reach them ([0012](0012-role-scoped-channels.md)); every role exports itself and admins anyone; export expiry in the daily jobs; erasure as the admin's action around the `erase_user()` database function, with the `erasures` log re-applied by `restore-db` after a restore, completing the restore procedure ([0017](0017-nfs-backup-storage.md)); reading audit events; in the UI, "My data" and "My activity" on the profile, the admin's data requests page and the activity log; `worker-e2e` for the end-to-end suite.

**Slice 9 — MCP servers for coding agents** ([0026](0026-mcp-development-tooling.md)): scoped down to two servers, because the Grafana, PostgreSQL and Valkey servers' images carried open findings and their access was not worth the surface yet; `@quasar/mcp` as a pinned dev dependency of the web app, offline; the Playwright MCP server that ships in the e2e suite's own `playwright-core`, in `mcp-browser` (the `e2e` image idling) on `mcp-edge`, an internal network holding only Nginx, so the browser reaches the local origins over trusted TLS and not the internet; the committed `.mcp.json` and the `enabledMcpjsonServers` allowlist in `.claude/settings.json`; `scripts/stack.sh mcp`, which starts both as `.mcp.json` does and checks them, run by `scripts/ci.sh`.

**Slice 10 — e-mail, done** ([0027](0027-email-templates-and-sending.md)): `defineMailKind()` and the kind registry; the user's `locale`; template revisions seeded from code defaults, checked against the kind's schema on save; Liquid, Markdown and the HTML layout with escaped output; the `mail_deliveries` outbox and its sweep; the `mail` queue with throttling and retries, sending through Mailpit; campaigns with preview and pinned revisions; the delivery log in the registry and the retention cleanup; the admin pages for templates and mailings; a demo notification and a demo campaign proven end to end in Mailpit. `e2e/tests/mail.spec.ts` asks for an export in English and finds the English `gdpr.export-ready` mail, sends `documents.stale-reminder` from the Mailings page after its preview and finds it, both through worker-e2e and in Mailpit (read through Nginx at `mail.localhost`), and has the template editor refuse a misspelled variable with its line and roll a saved version back.

**Slice 11 — sessions, done** ([0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md)): who is logged in, for admins and operators. The `sessions` service that the permission matrix's sessions row had lacked, over `auth_sessions`: active sessions only, `remove` revoking one (the row stays for reuse detection, the sockets close, `sessions.revoke` is audited); admins read and revoke every session, operators read them without the user agent, through a CASL field rule that the external resolver and the channel filter both apply; users have no access. The session store publishes logins, refreshes and every revocation as the service's events, so the Sessions page follows them live; it is filtered by person from the Users page.

**Slice 12 — editable roles and view-as, done** ([0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0028](0028-read-only-view-as.md)): the permission catalogue and the baseline in the ability module; `roles`, `role_permissions` and `user_roles` seeded with the former matrix and backfilled from `users.role`, which the contract step `20260930000000_drop_users_role` then dropped ([0003](0003-postgresql-and-knex.md)); permissions loaded per request, the access token without a role; the `roles` and `user-roles` services with their safeguards and audit events; subject channels in place of role channels; field rules shadowed by a broader rule dropped, since feathers-casl intersects them; the permissions page with the role preview; several roles per person on the Users page; view-as as state of the viewer's session, with the intersected ability built by the same function on both sides, its banner, and `viewAsMinutes`. Unit tests for the catalogue and the intersection, integration tests for roles, assignments, safeguards and view-as, and `e2e/tests/permissions.spec.ts` and `view-as.spec.ts`.

**Slice 13 — API tokens, done** ([0029](0029-api-tokens.md)): `api_tokens` with the SHA-256 of each token, never the token; the `api-token` strategy for `Authorization: Bearer apt_…` on REST only, parsed before the access token and never accepted by the authentication service; the token's ability built per request from its permissions that its owner holds, without the baseline, and only while the owner holds `api-tokens.create`; `api-tokens.create` and `api-tokens.manage` in the catalogue, own tokens in the baseline; the `api-tokens` service, whose `created` event carries no token; `api-tokens.create` and `api-tokens.revoke` audited, `api_token_ref` in the log lines; `erase_user()`, the registry and the export; every token deleted by the restore post-step, checked by `backup-test.sh`; the API tokens page with the token shown once. Unit tests for the token ability, `test/integration/api-tokens.test.ts`, and `e2e/tests/api-tokens.spec.ts`.

**Slice 14 — maintenance mode, done** ([0025](0025-runtime-settings.md)): the `maintenanceMode` setting given its behaviour. Holders of `settings.manage` keep using the application; switching the mode on revokes everyone else's sessions, and while it is on their service calls, refreshes and every API token are answered 503 with `data.maintenance`, the ACS sends their logins to `/maintenance`, and the worker pauses its BullMQ workers. `GET /api/maintenance` reports the state publicly. In the browser, the maintenance state and the public `/maintenance` page, reached on such a 503 or when the API does not answer, polling every 30 seconds and reloading at the login page once the mode is off; the confirmed switch on the Settings page and the banner for admins. `test/integration/maintenance-mode.test.ts`, unit tests for the refresh outcomes and the state, and `e2e/tests/maintenance.spec.ts`.

**Slice 15 — locations in NetBox, done** ([0031](0031-netbox-locations.md)): NetBox 4.7 in the stack (`netbox`, `netbox-worker`, the one-shot `netbox-setup`) on its own database and Valkey user, behind Nginx at `netbox.localhost` with TLS on both hops, its secrets from its own agent; `containers/netbox/seed/scrape_tu_locations.py`, which reads the university's building addresses and campus pages in German and English into committed JSON; the seed of regions, campus and section site groups and one site per building, upserted by slug so NetBox ids stay stable, with a seeded site the files drop set to retired; the api's read-only v2 token and user; SAML login to NetBox through the IdP with rights from the IdP's groups (LDAP groups and Keycloak mappers locally); the read-only `sites` service over NetBox's REST API under `sites.read`, which the seeded roles hold, and the Buildings page as a server-paginated table; NetBox's database in a fourth backup repository with `restore-netbox`. `test/integration/sites.test.ts`, `e2e/tests/locations.spec.ts` and the NetBox part of `backup-test.sh`.

**Slice 16 — system info and update check, done** ([0032](0032-system-info-and-update-check.md)): `scripts/inventory.sh` generates `apps/api/src/system/inventory.ts`, the declared version of every component production runs, from the image pins, and fails on an image without a component (a static CI check); the api image records the commit it was built from (`APP_COMMIT`, its time, uncommitted changes). The worker's daily update check lists the registries' tags and reads endoflife.date over a fixed host allowlist, stores per component the newest patch, minor and major, since when each is available and the line's end of life in `component_updates`, and exports them as metrics; `UPDATE_CHECK=off` in e2e and the tests. Grafana mails a patch waiting 7 days, an end of life within 90 days and a check failing for 3 days. `/system-info`, under `system-info.read` (admin only as seeded), shows per component the pinned version, the running one from Prometheus, Valkey, NetBox and the process, and the check's results; `system-info.check` (admin only as seeded) runs the check now, refused while one is under way, and a `check` event tells the page when it ends. `e2e/tests/system-info.spec.ts` reads the live stack's versions as an admin and finds no page for an operator.

**Slice 17 — every call configurable, done** ([0011](0011-casl-role-authorization.md), [0029](0029-api-tokens.md)): the baseline split into a fixed core (own record, own GDPR export, ending a view-as) and seven own-data catalogue permissions in the group `self`; the `everyone` role, a fourth kind held by every account without an assignment, editable, neither deletable nor assignable, seeded by `20261001000100_everyone_role` with those permissions; `loadAccess` adding its permissions; a change to it ending every signed-in connection; none of them a token permission; the permissions page with its column and a preview that adds it, the Users page without it. Unit tests for the fixed core, integration tests for the role's safeguards and for withdrawing and regranting, and `e2e/tests/permissions.spec.ts`.

**Slice 18 — personal preferences, done** ([0014](0014-frontend-quasar-vue.md), [0011](0011-casl-role-authorization.md)): the `preferences` table and its key registry, `apps/api/src/preferences/registry.ts`; the `preferences` service, generated with `pnpm gen:service`, whose `create` sets the caller's value and `remove` resets it, published to the person's own connections; `profile.preferences` granted to `everyone` by `20261002000000_preferences`, not a token permission; the table in the GDPR registry, the export and `erase_user()`. The first key, `navOrder`: the navigation drawer's arrange mode with up and down buttons and drag and drop, saved at once, reset to the default order. Unit tests for the ordering, `test/integration/preferences.test.ts`, and `e2e/tests/preferences.spec.ts`.

**Later.** The generated production units still publish Nginx on `127.0.0.1:8443`; that belongs to the production host work above.

## Status of this set

All thirty-four are `Accepted`: each states a decision that was actually made rather than a proposal awaiting review. Individual `Open questions` entries remain only where a detail genuinely depends on information from outside the project or on observing the running system — alert thresholds ([0022](0022-observability-and-alerting.md)), the issuer of production certificates for internal listeners ([0016](0016-nginx-and-tls-everywhere.md)), the university SMTP relay's sending limit ([0027](0027-email-templates-and-sending.md)), and the group attribute the university IdP releases to NetBox ([0031](0031-netbox-locations.md)).

The record of processing activities and the DPIA ([0013](0013-gdpr-export-and-retention.md)) are organisational deliverables to be prepared with the data protection officer before production; view-as ([0028](0028-read-only-view-as.md)) is part of them.
