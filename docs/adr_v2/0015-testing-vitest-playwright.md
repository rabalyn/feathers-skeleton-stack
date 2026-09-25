# 0015: Vitest for unit and integration tests, Playwright for browser end-to-end

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0056, 0057, 0058
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0004](0004-pgbouncer-pools.md), [0008](0008-authentication-saml2-ldap.md), [0016](0016-nginx-and-tls-everywhere.md), [0017](0017-nfs-backup-storage.md), [0023](0023-secrets-management.md)

## Decision

### Layers

| Layer | Runner | Runs against |
| --- | --- | --- |
| Unit | Vitest | Pure functions, hooks, resolvers, Vue components |
| Integration | Vitest | Real PostgreSQL through PgBouncer, real Valkey, real Garage |
| End-to-end | Playwright | Built `nginx` image with the bundled frontend over real TLS, with the Keycloak IdP |

**Vitest is the runner for everything except the browser.** Playwright exists because the login path is a multi-redirect SAML2 flow over TLS with cookie semantics that only a real browser exercises honestly — precisely the part of this system most worth testing.

### Nothing is mocked that the stack provides

PostgreSQL, Valkey, Garage, LDAP, Keycloak, OpenBao and Nginx all run as containers in every environment ([0001](0001-one-stack-every-environment.md)), so tests use the real thing. Mocks are for third-party services the stack does not contain, of which there are currently none.

### Parallel isolation: one database per worker

- Vitest runs inside the one-shot `test` container on the `app-data` network ([0002](0002-service-inventory-and-networks.md)), with its own OpenBao Agent delivering the test role's credential ([0023](0023-secrets-management.md)). It is never run against a port published from the host.
- Migrations run once into a template database, `test_template`, by the `migrate` job over its direct connection, before the `test` container starts.
- Each Vitest worker gets its own database, created with `CREATE DATABASE test_w<N> TEMPLATE test_template`. Cloning a template takes milliseconds and needs no per-worker migration run. Test data never crosses workers, and the application needs no test-only schema handling.
- Workers reach their database through PgBouncer's wildcard entry ([0004](0004-pgbouncer-pools.md)). Each worker caps its Knex pool at `{ min: 0, max: 2 }`; the test user's `max_user_connections` caps server connections across all workers, so a 48-worker run queues rather than exceeding PostgreSQL's `max_connections`.
- Transactions, including rollback of failed service chains, behave exactly as in production, because transaction-mode pooling assigns connections per transaction.
- Setup drops leftover `test_w*` databases before each run, so a crashed worker cannot leak state into the next run.

### End-to-end coverage

The first suite covers: SAML2 login through the local IdP, uploading and reading a document, uploading an avatar, a real-time update arriving over the WebSocket, role-based visibility (an `operator` and a `user` seeing different things), logout taking effect immediately, and the GDPR self-export returning the expected shape.

Playwright trusts the local CA root created by the `certs` job ([0016](0016-nginx-and-tls-everywhere.md)) rather than ignoring certificate errors, so TLS behaviour under test matches production.

Playwright runs inside the one-shot `e2e` container, built on the official Playwright image pinned by digest, on the `edge` and `idp-edge` networks ([0002](0002-service-inventory-and-networks.md)). Because Chromium resolves `*.localhost` to the loopback address, the browser is launched with a host-resolver rule mapping the local host names to the `nginx` container. It uses the same public origins, including the port, as a developer's browser. The same container runs locally and in CI, so no host Node.js or browser installation is involved.

### CI

The CI gate is **one script, `scripts/ci.sh`**, which needs nothing on the host but rootless Podman and runs identically on a developer machine and a runner. It runs gitleaks over the whole history ([0023](0023-secrets-management.md)), lint and the client dependency boundary ([0007](0007-typed-client-from-api.md)), typecheck, `pnpm audit` and the Quadlet regeneration check ([0001](0001-one-stack-every-environment.md)), then brings up the same `compose.yaml` stack and runs Vitest, Playwright and the image vulnerability scan ([0018](0018-owasp-security-baseline.md)); the backup-and-restore test ([0017](0017-nfs-backup-storage.md)) joins it with the backup service. Every check runs even after one fails, and the script reports all failures at the end. The static checks run in a `ci` image built from the workspace, so no host Node.js is involved.

The images that run pnpm after the build (`ci`, the api `test` target, `e2e`) set `pnpm_config_verify_deps_before_run=false`. Their dependencies are installed once with `--frozen-lockfile` at build time; pnpm's pre-run check would otherwise treat the build's own writes (a filtered install prunes the lockfile, later `COPY` and `chown` touch the manifests) as drift and try to reinstall as the unprivileged user, which fails. Developers on the host keep the check.

A hosted pipeline runs `scripts/ci.sh --cold`, which resets the stack first as a fresh runner would. **The GitHub Actions workflow is not written yet**: the repository has no remote, and GitHub's hosted Ubuntu images ship an older Podman than the stack is built and verified on (6.1). The workflow is added when the repository is published, either installing a current Podman on a hosted runner or on a self-hosted one; it calls the script and holds no logic of its own.

Lint is ESLint with type-aware `typescript-eslint` rules for every TypeScript package. The client boundary is checked by dependency-cruiser, because ESLint rules see one file at a time and the boundary is about whole import chains.

Two CI-specific points:

- **Real NFS for the backup test.** The runner is a disposable VM with root, so the job installs an NFS server on the runner, mounts its export, and bind-mounts it into the `backup` container at `/srv/backups`. Local development uses a named volume instead, because rootless Podman can neither mount NFS nor run an NFS server.
- **Secrets are random per run.** CI initialises its own OpenBao and fills it with generated values ([0023](0023-secrets-management.md)). No real secret or decryption key exists in GitHub Actions.

## Consequences

- Integration and end-to-end tests need the container stack, so the test suite is not runnable without it. This is the accepted cost of testing against real infrastructure.
- CI wall time is dominated by container startup, with Keycloak the slowest to become healthy.
- The NFS backup path is exercised on every pipeline but not on developer machines; a regression in NFS handling surfaces in CI, not locally.
