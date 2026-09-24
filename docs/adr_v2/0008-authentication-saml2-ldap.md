# 0008: Authentication via SAML2, with a local IdP container for development and a break-glass superadmin

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0022, 0026
- Related: [0002](0002-service-inventory-and-networks.md), [0009](0009-tu-id-identity-model.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0018](0018-owasp-security-baseline.md)

## Context

TU Darmstadt's preferred login method is SAML2. The university identity provider is unreachable from a developer machine or from CI, which would normally force a second authentication path for local work — exactly the kind of environment divergence [0001](0001-one-stack-every-environment.md) exists to prevent.

## Decision

### SAML2 is the only university login path

The application is a SAML2 **service provider**. It never sees a university password; credentials are entered at the identity provider and the application receives a signed assertion.

- Production: the SP is configured against the university identity provider.
- Local and CI: the SP is configured against a **Keycloak container** acting as the identity provider, which uses **LDAP user federation** against the seeded `ldap` container as its user store, and is configured declaratively through a realm import file committed to the repository.
- Locally the browser reaches Keycloak through Nginx under its own host name (for example `idp.localhost`), over the same TLS as the application ([0016](0016-nginx-and-tls-everywhere.md)). In production the IdP is external and Nginx has no such virtual host.

The application code, routes, assertion handling and session issuance are identical in both cases. Only the IdP metadata URL and certificate differ, by configuration.

### Attributes

The TU-ID is carried in **`cn`**. The SP requests and maps: `cn` (TU-ID), `givenName` (name), `sn` (surname), `mail`. The local realm import and LDAP seed use the same attribute names.

### LDAP

The `ldap` container (OpenLDAP) is seeded at startup with a small set of test users carrying `cn` (TU-ID), `givenName`, `sn`, `mail` and `userPassword`. It serves two consumers:

- **Keycloak** binds to it as its user store, which is the shape the university deployment has.
- **The API** binds to it with a read-only service account for **directory lookup**: finding a person who has not logged in yet. Lookup is available to `admin` and `operator` only ([0011](0011-casl-role-authorization.md)). The same kind of service account is already in use against the university directory by other applications. Every filter built from user input is escaped ([0018](0018-owasp-security-baseline.md)).

The API never uses LDAP to authenticate a user. Login is SAML2 only.

### Break-glass superadmin

One local account, authenticated by email and password, exists so the system is administrable when SAML2 is unavailable or before any user has logged in.

- Password hashed with **argon2id**.
- Created only by the one-time bootstrap command, never automatically at startup.
- Holds the `admin` role ([0011](0011-casl-role-authorization.md)).
- Subject to the same rate limits as every other login, and every authentication attempt against it — successful or not — is recorded as an audit event.
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

### After successful authentication

The SP issues the application's own session ([0010](0010-sessions-postgres-ratelimits-valkey.md)) and does not retain or re-present the assertion. On first login, the user record is provisioned just-in-time from the asserted attributes, keyed by TU-ID ([0009](0009-tu-id-identity-model.md)).

SP-initiated logout is supported. IdP-initiated single logout is out of scope initially; local session revocation is always authoritative for this application.

## Consequences

- The production login flow — redirects, assertion validation, attribute mapping, JIT provisioning — is exercised by every local run and every CI run.
- Keycloak is a heavy container (slowest service to become healthy in the stack), which lengthens cold CI startup.
- The realm import file and LDAP seed are test fixtures that must be kept in step with the attribute mapping as it changes.
- A break-glass password exists and is therefore a target; its audit trail and rate limiting are not optional.
- The API holds an LDAP service credential, delivered like every other secret ([0023](0023-secrets-management.md)).
