# 0023: Secrets in OpenBao, delivered per service as files in tmpfs

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADR 0067
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0008](0008-authentication-saml2-ldap.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0015](0015-testing-vitest-playwright.md), [0016](0016-nginx-and-tls-everywhere.md), [0017](0017-nfs-backup-storage.md), [0018](0018-owasp-security-baseline.md), [0022](0022-observability-and-alerting.md)

## Context

The stack needs many credentials: database roles, the authentication signing secret, the refresh token key, the SAML SP private key, the LDAP service account, object storage keys, the Valkey password, the restic repository password, SMTP credentials, and the Grafana admin password.

Three constraints shape the design:

- Credentials must not be reachable by tooling with access to the working directory, coding agents included.
- No plaintext credential may sit on disk between runs.
- The secret store is crucial infrastructure and should not have to be replaced later, so it is chosen for where the system is going (several products, possibly several hosts and operators), not only for today.

Environment files fail the first two constraints. An encrypted file in the repository (SOPS) meets them but offers no per-service access control at runtime, no audit log, and no path to short-lived credentials, so it would eventually be replaced.

## Decision

### OpenBao is the only secret store

**OpenBao** (the open-source, Linux Foundation fork of HashiCorp Vault) runs as the `openbao` container in every environment, with integrated (raft) storage on its own volume. There is no SOPS file and no other secret source.

- Secrets are **static** values in the KV v2 engine, one path per consuming service, `kv/<service>`, with one key per file the agent renders (key `database_password` becomes `/run/secrets/database_password`). Dynamic, short-lived database credentials are possible later as a change of engine, not of store; they are not used in v1 because they would rebuild PgBouncer's per-user pools on every rotation ([0004](0004-pgbouncer-pools.md)).
- Each service has a **policy** granting read access to its own path only. The API cannot read the restic password; the backup service cannot read the Grafana credentials.
- OpenBao's listener uses **TLS**, and agents verify its certificate against a configured CA root. Secret values and `secret_id` unwrap calls never cross a network in plaintext, even the internal `secrets` network. Locally and in CI the `certs` job issues the `openbao` server certificate from the local CA; the production source is an open question in [0016](0016-nginx-and-tls-everywhere.md).
- OpenBao's **audit device** is declared in the server configuration (OpenBao accepts no other way) and written to the shared log volume, so every secret access is shipped to Loki ([0021](0021-structured-logging.md)). Audit entries contain HMACs of values, never the values.

### Sealing and unsealing

OpenBao starts **sealed** and cannot read its own storage until unsealed.

| Environment | Unseal |
| --- | --- |
| Production | **Manually, by an administrator**, after every start of the host or the `openbao` container, with `scripts/openbao.sh unseal`. Initialisation creates **one** unseal key share, kept twice: in the team's KeePass store and in an offline copy |
| Local, CI | Scripted. The first start initialises OpenBao, keeps the unseal key in a local container volume, and fills every secret path with generated random values |

The server configuration, policies and secret paths are identical in every environment; only who unseals, and whether the values are real, differs ([0001](0001-one-stack-every-environment.md)). The root token is revoked once initial configuration is done and regenerated from the unseal shares only when needed, so it is never stored. Administrators work with personal OpenBao accounts (**userpass**, one per person, so nothing outside OpenBao is needed to reach it) whose policy covers issuing agent credentials, editing secret values, managing the administrators' own accounts, and **starting** root generation, nothing more. OpenBao refuses unauthenticated root generation by default (`disable_unauthed_generate_root_endpoints`), and that default is kept: starting it needs an administrator's account, and completing it still needs the unseal key shares. Locally, a periodic token with the same admin policy, kept in the local unseal volume, stands in for the administrator's account.

A single share suits a team of one or two administrators: any copy unseals on its own. OpenBao refuses several shares with a threshold of one, so "two copies" is one share stored twice rather than two shares. When the team grows, `bao operator rekey` replaces it with more shares and a higher threshold without reinitialising; it needs the current threshold of shares.

### The production procedure

`scripts/openbao.sh` is what an administrator runs on the production host; it shares its OpenBao functions with the local `scripts/stack.sh` (`scripts/openbao-lib.sh`), so policies, AppRoles and secret paths cannot drift apart. Key shares and passwords are read from the terminal, never from arguments or the environment, and every run revokes the token it used.

- `init --admin <name>`, once: initialises with one share and prints it once, unseals, writes the policies and AppRoles, creates the first administrator's account, generates every value the stack only shares with itself, issues the running agents' `secret_id`s, lists what is still missing, and revokes the root token.
- `unseal` after every start, `reissue` after an agent restarted on its own, `set <service> <key>` for one value from stdin (a whole PEM file may be piped in), `missing`, and `add-admin <name>` for a colleague's account. All but `init` log in as an administrator.
- Values follow the same manifest as locally, `containers/openbao/secrets.conf`, restricted to the services that have an agent in production (a Quadlet unit). Values the stack only shares with itself are generated, the SAML SP key pair included ([0008](0008-authentication-saml2-ldap.md)). Values that come from outside (generator `local`: the university LDAP service account's password, the SMTP relay's) and the IdP's certificate are written by an administrator with `set`. Values of local test clients (generator `local-only:<generator>`, e.g. the integration tests' S3 key) do not exist in production at all, even where their target is a production agent; `missing` compares the agents' templates with what OpenBao holds.
- `scripts/openbao-test.sh` runs the whole procedure in CI against a throwaway OpenBao and a stand-in agent ([0015](0015-testing-vitest-playwright.md)): init, the generated and missing values, `set`, a second administrator, a restart, a wrong key and the unseal that re-issues the agent's credential.

### Delivery: one OpenBao Agent per service, files in tmpfs

Every service that reads a secret has its own **OpenBao Agent** container (`<service>-agent`) on the `secrets` network. The agent authenticates with that service's AppRole, renders the service's secrets as individual files into a **tmpfs** volume shared with the service, and re-renders them when they change. The service mounts it read-only at `/run/secrets`.

```
/run/secrets/database_password
/run/secrets/auth_signing_secret
/run/secrets/saml_sp_key
…
```

Application containers never talk to OpenBao and are not on the `secrets` network. The file layout is the same in every environment.

**Getting each agent its first credential.** Each agent's AppRole `role_id` is part of its configuration. Its `secret_id` is issued by the unseal procedure as a response-wrapped token, unwrapped inside the agent container, and kept only in that agent's own tmpfs. It lives exactly as long as that agent container: a tmpfs volume used by one container is emptied when the container stops, and systemd restarts Quadlet containers by stopping and recreating them. **Any stop or start of an agent therefore needs a new `secret_id`**, as does a host reboot. This is verified behaviour, not an assumption. Two things soften it: the files already rendered sit in the tmpfs shared with the service, which stays mounted while the service runs, so the service keeps working; and only re-rendering (rotation, or a restarted service) waits for the re-issue. In production the administrator who unseals OpenBao re-issues the `secret_id`s (`scripts/openbao.sh unseal`), which is the same moment a person is present anyway, and an agent that stopped on its own is re-issued by an administrator the same way (`reissue`). Locally and in CI the setup script does this.

The local and CI setup script runs on the host and works only through `podman exec` into the `openbao` container (and, to exchange certificates with the local IdP, the `idp` and `nginx` containers, [0008](0008-authentication-saml2-ldap.md)). It therefore needs no additional service and no network membership. It is idempotent: a second run unseals and re-issues `secret_id`s but does not regenerate values that already exist. `scripts/stack.sh test` issues a `secret_id` to the test agent alone, and only when it recreates that agent ([0015](0015-testing-vitest-playwright.md)).

### Containers read files, never environment variables

Configuration references paths, not values:

```
DATABASE_PASSWORD_FILE=/run/secrets/database_password
AUTH_SIGNING_SECRET_FILE=/run/secrets/auth_signing_secret
SAML_SP_PRIVATE_KEY_FILE=/run/secrets/saml_sp_key
RESTIC_PASSWORD_FILE=/run/secrets/restic_password
```

The configuration layer resolves `*_FILE` at startup. Secrets are never plain environment variables, because those are exposed through `podman inspect`, `/proc/<pid>/environ`, crash dumps, and any library that logs its own configuration. A third-party image that accepts only an environment variable gets a small entrypoint shim that reads the file and exports it into that process alone.

The application **has no dotenv dependency**. A stray `.env` file therefore does nothing.

### What this gives against working-directory tooling

- The working directory contains no secret, encrypted or otherwise, and no key. Local secrets are random values inside OpenBao's volume, and production secrets never exist on a developer machine.
- **One stated exception:** the passwords of the seeded LDAP test users are committed as part of the LDAP seed, because an end-to-end test has to type them into the local IdP ([0008](0008-authentication-saml2-ldap.md), [0015](0015-testing-vitest-playwright.md)). They exist only in the local and CI directory and grant nothing outside it. Every other credential of the local-only containers — the Keycloak admin password, Keycloak's LDAP bind credential, the LDAP admin password — is generated by the setup script and delivered through OpenBao like any other secret, and the local IdP generates its own signing key.
- CI generates its own random secrets per run; no real secret or decryption key is held in GitHub Actions.
- `gitleaks` runs as a CI gate over the whole history and as a pre-commit hook on the staged changes, as a backstop against accidents. The hook lives in `.githooks/` and is switched on by `pnpm install` (`core.hooksPath`); like everything else it runs in a container.

### Rotation

A value is rotated by writing a new version in OpenBao; the agent re-renders the file and the affected service is restarted. Consequences worth stating:

- Rotating the **authentication signing secret** invalidates outstanding access tokens only; clients refresh and nobody is logged out ([0010](0010-sessions-postgres-ratelimits-valkey.md)).
- Rotating the **refresh token key** affects only the refresh grace window: a retry with a just-rotated token within that window, straddling the rotation, is treated as reuse and logs that one session out. Nobody else is affected ([0010](0010-sessions-postgres-ratelimits-valkey.md)).
- The **restic password** is changed through restic's own key management (add the new key, then remove the old one), never by overwriting it, and the KeePass copy is updated in the same step. Losing it makes every backup unrecoverable ([0017](0017-nfs-backup-storage.md)).

### Backup

OpenBao's storage is backed up as a raft snapshot by the backup service ([0017](0017-nfs-backup-storage.md)). A restored snapshot is unusable without the unseal shares, which is why they live outside the system, in KeePass.

## Consequences

- Secrets are encrypted at rest, access-controlled per service, audited, and present in plaintext only in tmpfs while the stack runs.
- **After every reboot, the stack cannot start until an administrator unseals OpenBao.** This is deliberate: it is what keeps the unseal key off the host. Unattended restarts are not possible.
- While OpenBao is sealed or down, no service can start fresh; services already running keep their rendered files.
- An agent that crashes or is restarted cannot re-authenticate on its own. Its service keeps running on the files already rendered, but in production a person has to re-issue the agent's `secret_id` before secrets can rotate or the service can restart cleanly. This is the price of never storing an agent credential outside a tmpfs.
- Every secret-reading service gains an agent container, roughly doubling the container count for those services.
- A new secret means deciding which service's path it belongs to and updating that policy, which is the intended moment to think about least privilege.
- The team must learn to operate OpenBao: initialisation, unsealing, policies and snapshot restore. The restore test in CI exercises the last of these on every pipeline.
