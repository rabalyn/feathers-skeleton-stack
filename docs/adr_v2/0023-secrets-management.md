# 0023: Secrets in OpenBao, delivered per service as files in tmpfs

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADR 0067
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0008](0008-authentication-saml2-ldap.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0015](0015-testing-vitest-playwright.md), [0017](0017-nfs-backup-storage.md), [0018](0018-owasp-security-baseline.md), [0022](0022-observability-and-alerting.md)

## Context

The stack needs many credentials: database roles, the authentication signing secret, the SAML SP private key, the LDAP service account, object storage keys, the Valkey password, the restic repository password, SMTP credentials, and the Grafana admin password.

Three constraints shape the design:

- Credentials must not be reachable by tooling with access to the working directory, coding agents included.
- No plaintext credential may sit on disk between runs.
- The secret store is crucial infrastructure and should not have to be replaced later, so it is chosen for where the system is going (several products, possibly several hosts and operators), not only for today.

Environment files fail the first two constraints. An encrypted file in the repository (SOPS) meets them but offers no per-service access control at runtime, no audit log, and no path to short-lived credentials, so it would eventually be replaced.

## Decision

### OpenBao is the only secret store

**OpenBao** (the open-source, Linux Foundation fork of HashiCorp Vault) runs as the `openbao` container in every environment, with integrated (raft) storage on its own volume. There is no SOPS file and no other secret source.

- Secrets are **static** values in the KV v2 engine, one path per consuming service. Dynamic, short-lived database credentials are possible later as a change of engine, not of store; they are not used in v1 because they would rebuild PgBouncer's per-user pools on every rotation ([0004](0004-pgbouncer-pools.md)).
- Each service has a **policy** granting read access to its own path only. The API cannot read the restic password; the backup service cannot read the Grafana credentials.
- OpenBao's **audit device** is enabled and written to the shared log volume, so every secret access is shipped to Loki ([0021](0021-structured-logging.md)). Audit entries contain HMACs of values, never the values.

### Sealing and unsealing

OpenBao starts **sealed** and cannot read its own storage until unsealed.

| Environment | Unseal |
| --- | --- |
| Production | **Manually, by an administrator**, after every start of the host or the `openbao` container. The unseal key is split into shares at initialisation; the shares and the initial root token are kept in the team's KeePass store |
| Local, CI | Scripted. The first start initialises OpenBao, keeps the unseal key in a local container volume, and fills every secret path with generated random values |

The server configuration, policies and secret paths are identical in every environment; only who unseals, and whether the values are real, differs ([0001](0001-one-stack-every-environment.md)). The root token is revoked once initial configuration is done and regenerated from the unseal shares only when needed. Administrators work with personal OpenBao accounts whose policy covers issuing agent credentials and editing secret values, nothing more.

### Delivery: one OpenBao Agent per service, files in tmpfs

Every service that reads a secret has its own **OpenBao Agent** container (`<service>-agent`) on the `secrets` network. The agent authenticates with that service's AppRole, renders the service's secrets as individual files into a **tmpfs** volume shared with the service, and re-renders them when they change. The service mounts it read-only at `/run/secrets`.

```
/run/secrets/database_password
/run/secrets/auth_signing_secret
/run/secrets/saml_sp_key
…
```

Application containers never talk to OpenBao and are not on the `secrets` network. The file layout is the same in every environment.

**Getting each agent its first credential.** Each agent's AppRole `role_id` is part of its configuration. Its `secret_id` is issued by the unseal procedure, response-wrapped, into that agent's own tmpfs. It therefore survives a container restart but not a host reboot. After a reboot the administrator who unseals OpenBao also re-issues the `secret_id`s, which is the same moment a person is present anyway. Locally and in CI the setup script does this.

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
- CI generates its own random secrets per run; no real secret or decryption key is held in GitHub Actions.
- `gitleaks` runs as a CI gate and a pre-commit hook as a backstop against accidents.

### Rotation

A value is rotated by writing a new version in OpenBao; the agent re-renders the file and the affected service is restarted. Consequences worth stating:

- Rotating the **authentication signing secret** invalidates outstanding access tokens only; clients refresh and nobody is logged out ([0010](0010-sessions-postgres-ratelimits-valkey.md)).
- The **restic password** is changed through restic's own key management (add the new key, then remove the old one), never by overwriting it, and the KeePass copy is updated in the same step. Losing it makes every backup unrecoverable ([0017](0017-nfs-backup-storage.md)).

### Backup

OpenBao's storage is backed up as a raft snapshot by the backup service ([0017](0017-nfs-backup-storage.md)). A restored snapshot is unusable without the unseal shares, which is why they live outside the system, in KeePass.

## Consequences

- Secrets are encrypted at rest, access-controlled per service, audited, and present in plaintext only in tmpfs while the stack runs.
- **After every reboot, the stack cannot start until an administrator unseals OpenBao.** This is deliberate: it is what keeps the unseal key off the host. Unattended restarts are not possible.
- While OpenBao is sealed or down, no service can start fresh; services already running keep their rendered files.
- Every secret-reading service gains an agent container, roughly doubling the container count for those services.
- A new secret means deciding which service's path it belongs to and updating that policy, which is the intended moment to think about least privilege.
- The team must learn to operate OpenBao: initialisation, unsealing, policies and snapshot restore. The restore test in CI exercises the last of these on every pipeline.
