# 0008: Authentication via SAML2, with a local IdP container for development and a break-glass superadmin

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0022, 0026
- Related: [0002](0002-service-inventory-and-networks.md), [0004](0004-pgbouncer-pools.md), [0006](0006-feathersjs-typescript-api.md), [0009](0009-tu-id-identity-model.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0018](0018-owasp-security-baseline.md), [0023](0023-secrets-management.md), [0024](0024-background-jobs-bullmq.md)

## Context

TU Darmstadt's preferred login method is SAML2. The university identity provider is unreachable from a developer machine or from CI, which would normally force a second authentication path for local work — exactly the kind of environment divergence [0001](0001-one-stack-every-environment.md) exists to prevent.

## Decision

### SAML2 is the only university login path

The application is a SAML2 **service provider**. It never sees a university password; credentials are entered at the identity provider and the application receives a signed assertion.

- Production: the SP is configured against the university identity provider.
- Local and CI: the SP is configured against a **Keycloak container** acting as the identity provider, which uses **LDAP user federation** against the seeded `ldap` container as its user store, and is configured declaratively through a realm import file committed to the repository.
- Locally the browser reaches Keycloak through Nginx under its own host name (for example `idp.localhost`), over the same TLS as the application ([0016](0016-nginx-and-tls-everywhere.md)). In production the IdP is external and Nginx has no such virtual host.

The local Keycloak exists only to get development and testing going quickly, so it is kept self-contained: it runs in `start-dev` mode on Keycloak's embedded storage, kept on its own volume, imports the committed realm on first start, and has no database connection. Its production-mode behaviour is irrelevant here, because production never runs it. If embedded storage ever becomes a problem, giving it a PostgreSQL database is acceptable; it is a development tool, not part of the production topology.

The application code, routes, assertion handling and session issuance are identical in both cases. Only the IdP metadata URL and certificate differ, by configuration.

### Attributes

The TU-ID is carried in **`cn`**. The SP requests and maps: `cn` (TU-ID), `givenName` (name), `sn` (surname), `mail`. The local realm import and LDAP seed use the same attribute names.

### LDAP

The `ldap` container (OpenLDAP) serves **LDAPS only**, with a certificate from the local CA ([0016](0016-nginx-and-tls-everywhere.md)), so no bind credential crosses a network in plaintext and the API's LDAP client uses TLS exactly as it will against the university directory. It is seeded at startup with a small set of test users carrying `cn` (TU-ID), `givenName`, `sn`, `mail` and `userPassword`. It serves two consumers:

- **Keycloak** binds to it as its user store, which is the shape the university deployment has.
- **The API** binds to it with a read-only service account for **directory lookup**: finding a person who has not logged in yet. Lookup is available to `admin` and `operator` only ([0011](0011-casl-role-authorization.md)). The same kind of service account is already in use against the university directory by other applications. Every filter built from user input is escaped ([0018](0018-owasp-security-baseline.md)).

The API never uses LDAP to authenticate a user. Login is SAML2 only.

**Directory lookup** is the read-only `directory` service, `GET /api/directory?q=…`:

- One search term of at least **two** characters (historical TU-IDs have two), split into words. Every word must be a **prefix** of the TU-ID (`cn`), given name, surname or mail, so `Uma Us` finds Uma User. Prefix matching uses the directory's initial-substring indexes even for two-character words, where a "contains" match would scan the whole directory.
- Every word is escaped before it enters the filter. The search asks only for `cn`, `givenName`, `sn` and `mail`.
- The directory returns at most **50** entries per search. The answer uses the usual page shape plus `truncated`, which says there were more and the term should be narrowed.
- Each result carries the `userId` of the person's account if they have logged in before, and `null` otherwise. Lookup creates nothing: a person gets an account only by logging in ([0009](0009-tu-id-identity-model.md)).
- A directory that is unreachable or refuses the service account is answered with **503**.
- Lookups are not audit events, like reading user records; the search term is never logged.
- Locally the service account is `cn=api,ou=services` in the test directory, readable only on the people subtree and never on passwords. Its password is generated at setup and delivered through OpenBao. Service accounts are added to an existing local directory at start when missing.

### Break-glass superadmin

One local account, authenticated by email and password, exists so the system is administrable when SAML2 is unavailable or before any user has logged in.

- Password hashed with **argon2id** (Node's built-in implementation; 64 MiB, three passes, four lanes, RFC 9106's second recommended option), stored as a PHC string in `local_credentials`, a table of its own that nothing reading `users` touches. A unique index allows at most one local account.
- Created only by the bootstrap command, never automatically at startup. The command runs inside the api container with the api's own configuration and database login, so it needs no credentials of its own:
  - `podman exec api node dist/bootstrap.js --email <address>` creates the account. It refuses when a local account exists or the address belongs to another account.
  - `podman exec api node dist/bootstrap.js --rotate` gives the existing account a new password and revokes all of its sessions. It is the recovery path for a lost or leaked password.
  - The password is **generated** (192 random bits) and printed to stdout **once**, for the administrator to store in KeePass next to the OpenBao unseal shares. It is never an argument, an environment variable or a log line, and it is deliberately not kept in OpenBao: the account must work when OpenBao does not. Creation and rotation are audit events without an actor.
  - Runtime settings are not the bootstrap's concern: `migrate` seeds them ([0025](0025-runtime-settings.md)).
- Holds the `admin` role ([0011](0011-casl-role-authorization.md)).
- Logs in with the `password` strategy of `/api/authentication` (email and password), over REST only and from the application's own origin, like refresh. A successful login opens a session exactly as the ACS does ([0010](0010-sessions-postgres-ratelimits-valkey.md)). Wrong password, unknown address and disabled account get the same 401; an unknown address is verified against a decoy hash, so it takes as long.
- Subject to the same rate limits as every other login, and every authentication attempt against it — successful or not — is recorded as an audit event. Every attempt is also logged at `warn`; repeated failures alert, and so does every successful login, since it means either an emergency or a leaked password ([0022](0022-observability-and-alerting.md)).
- The UI offers the login on a route of its own, `/break-glass`, which the normal login page does not link to ([0014](0014-frontend-quasar-vue.md)).
- Locally and in CI, `scripts/stack.sh up` runs the same bootstrap command for `breakglass@app.localhost` and keeps that password in OpenBao; `scripts/stack.sh breakglass` prints it, for trying the login by hand. The end-to-end suite bootstraps `breakglass@e2e.localhost` in its own database for every run ([0015](0015-testing-vitest-playwright.md)).
- This is the only password the application stores.

### Assertion validation

Every assertion is rejected unless all of the following hold. SAML implementations fail through exactly these gaps, so the list is normative:

- XML signature valid against the IdP's configured certificate, with the signature covering the assertion actually consumed (signature-wrapping defence),
- `Issuer` matches the configured IdP,
- `Audience` matches this SP's entity ID,
- `Destination` / `Recipient` matches this SP's ACS URL,
- `NotBefore` / `NotOnOrAfter` within clock skew tolerance,
- `InResponseTo` matches an authentication request this SP issued and has not yet consumed,
- the assertion ID has not been seen before (replay cache, TTL at least the assertion validity window).

Signature verification uses the configured certificate only. Certificates embedded in the response are never trusted.

### The SP's own key pair

The SP **signs** its authentication and logout requests and **accepts encrypted assertions**, decrypting them with the same key (`/run/secrets/saml_sp_key`). Its certificate is published in the SP metadata at `/api/auth/saml/metadata`. Encrypted assertions are what federation IdPs such as the university's commonly send, so the local Keycloak is configured to require signed requests and to encrypt, and the production-likely path is the one exercised. The SP key pair is generated by the setup script locally and by the production OpenBao initialisation on the production host, and lives only in OpenBao, like any other secret ([0023](0023-secrets-management.md)).

### Return path

`/api/auth/saml/login?returnTo=<path>` stores the requested path server-side, next to the request ID. After a successful login the ACS redirects there only if it is a same-origin relative path — a single leading `/`, no scheme, no `//` or `\` — and to `/` otherwise, so the login flow cannot be used as an open redirect.

### SAML library and request state

- The SP is built on **`@node-saml/node-saml`**, the library underneath `passport-saml`, used directly without Passport and wrapped in the custom `AuthenticationStrategy` ([0006](0006-feathersjs-typescript-api.md)). Checks from the list above that the library does not enforce itself are implemented explicitly in the strategy: the assertion's `Issuer` (the library checks it only on logout messages), `Destination` / `Recipient`, the assertion-ID replay check, and an atomic `InResponseTo` check (the library's own is a separate read and delete). Every item on the list has its own negative test, so the division between library and strategy is verified rather than assumed.
- Outstanding authentication request IDs (for `InResponseTo`) and consumed assertion IDs (the replay cache) are stored in **PostgreSQL**, each row with an expiry. A request ID is consumed atomically (`DELETE … RETURNING`), and assertion IDs are protected by a unique constraint, so both checks hold across several API processes and fit transaction-mode pooling ([0004](0004-pgbouncer-pools.md)). Expired rows are deleted opportunistically on insert until the maintenance job in [0024](0024-background-jobs-bullmq.md) takes over. Keeping this state in PostgreSQL rather than Valkey means a Valkey outage affects rate limiting only, not assertion validation.
- The IdP signing certificate reaches the API as a file, `/run/secrets/saml_idp_cert`, delivered like the SP key ([0023](0023-secrets-management.md)). In production an administrator writes the university IdP's certificate into OpenBao. Locally and in CI, Keycloak generates its own realm key on import and the setup script reads the certificate from Keycloak's SAML descriptor into OpenBao, and writes the SP certificate into the realm's client. No IdP key is committed to the repository.

### After successful authentication

The SP issues the application's own session ([0010](0010-sessions-postgres-ratelimits-valkey.md)) and does not retain or re-present the assertion. On first login, the user record is provisioned just-in-time from the asserted attributes, keyed by TU-ID ([0009](0009-tu-id-identity-model.md)).

SP-initiated logout is supported. IdP-initiated single logout is out of scope initially; local session revocation is always authoritative for this application.

## Consequences

- The production login flow — redirects, assertion validation, attribute mapping, JIT provisioning — is exercised by every local run and every CI run.
- Keycloak is a heavy container (slowest service to become healthy in the stack), which lengthens cold CI startup.
- The realm import file and LDAP seed are test fixtures that must be kept in step with the attribute mapping as it changes. The seeded test users' passwords are the only credentials committed to the repository; Keycloak's admin password and LDAP bind credential are generated at setup and delivered through OpenBao ([0023](0023-secrets-management.md)).
- A break-glass password exists and is therefore a target; its audit trail and rate limiting are not optional.
- `--rotate` revokes the account's sessions in the database, which ends access at the next request. An api process holding a WebSocket of that account closes it only on restart, because the command runs as a process of its own.
- The API holds an LDAP service credential, delivered like every other secret ([0023](0023-secrets-management.md)).
