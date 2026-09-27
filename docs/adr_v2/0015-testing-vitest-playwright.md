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
- Migrations run once into a template database, `test_template`, by the `migrate` job over its direct connection, before the `test` container starts. Locally, `scripts/stack.sh test` keeps what an earlier run left in place: it rebuilds `test_template` only when a fingerprint of the sources the build runs (migrations, the migrate entry point, the settings it seeds) differs from the one stored on the template, and recreates the test OpenBao Agent only when it is not running or its configuration changed. A rerun therefore costs the image build and the tests, not the provisioning.
- Each Vitest worker gets its own database, created with `CREATE DATABASE test_w<N> TEMPLATE test_template`. Cloning a template takes milliseconds and needs no per-worker migration run. Test data never crosses workers, and the application needs no test-only schema handling.
- Workers reach their database through PgBouncer's wildcard entry ([0004](0004-pgbouncer-pools.md)). Each worker caps its Knex pool at `{ min: 0, max: 2 }`; the test user's `max_user_connections` caps server connections across all workers, so a 48-worker run queues rather than exceeding PostgreSQL's `max_connections`.
- Transactions, including rollback of failed service chains, behave exactly as in production, because transaction-mode pooling assigns connections per transaction.
- Setup drops leftover `test_w*` databases before each run, so a crashed worker cannot leak state into the next run.

### End-to-end coverage

The first suite covers: SAML2 login through the local IdP, uploading and reading a document, uploading an avatar, a real-time update arriving over the WebSocket, role-based visibility (an `operator` and a `user` seeing different things), logout taking effect immediately, and the GDPR self-export returning the expected shape. It also covers erasure on the admin's data requests page and the activity log that records it.

Playwright trusts the local CA root created by the `certs` job ([0016](0016-nginx-and-tls-everywhere.md)) rather than ignoring certificate errors, so TLS behaviour under test matches production.

Playwright runs inside the one-shot `e2e` container, built on the official Playwright image pinned by digest, on the `edge` and `idp-edge` networks ([0002](0002-service-inventory-and-networks.md)). Because Chromium resolves `*.localhost` to the loopback address, the browser is launched with a host-resolver rule mapping the local host names to the `nginx` container. It uses the same public origins, including the port, as a developer's browser. The same container runs locally and in CI, so no host Node.js or browser installation is involved.

**The end-to-end suite has data of its own.** It never runs against the local `app` a developer works with, so a manual check is never disturbed by a test changing data in the background. `scripts/stack.sh e2e` drops and recreates the database `app_e2e` (created like `app`), migrates it, starts **`api-e2e`** on it (the api's image and configuration, `test` profile, with its own rate-limit prefix, queue prefix and buckets and no log file, so its lines stay out of Loki and the alert rules) and **`worker-e2e`** beside it (the worker on `app_e2e`, the same prefix and buckets, so the suite's GDPR exports are built from its own data), seeds the test accounts and bootstraps a break-glass account of its own. It then runs Playwright against **`https://e2e.localhost:8443`**, Nginx's virtual host for `api-e2e`, and removes both afterwards. The local Keycloak has one SAML client per origin, sharing the api's SP key pair. PostgreSQL, PgBouncer, Valkey, Keycloak and LDAP are shared; no data is. Every run therefore starts from the same empty database, and what a test changes is gone by the next run. The price is that the browser tests exercise a second api process rather than the one behind `app.localhost`; the two differ only in origin, database, buckets and key prefixes.

### CI

The CI gate is **one script, `scripts/ci.sh`**, which needs nothing on the host but rootless Podman and runs identically on a developer machine and a runner. It runs gitleaks over the whole history ([0023](0023-secrets-management.md)), lint and the client dependency boundary ([0007](0007-typed-client-from-api.md)), typecheck, `pnpm audit`, the Quadlet regeneration check ([0001](0001-one-stack-every-environment.md)) and the production OpenBao procedure against a throwaway OpenBao ([0023](0023-secrets-management.md)), then brings up the same `compose.yaml` stack and runs Vitest, Playwright, the alert delivery check, the backup-and-restore cycle (`scripts/backup-test.sh`, [0017](0017-nfs-backup-storage.md)) and the image vulnerability scan ([0018](0018-owasp-security-baseline.md)). Every check runs even after one fails, and the script reports all failures at the end. The static checks run in a `ci` image built from the workspace, so no host Node.js is involved.

The images that run pnpm after the build (`ci`, the api `test` target, `e2e`) set `pnpm_config_verify_deps_before_run=false`. Their dependencies are installed once with `--frozen-lockfile` at build time; pnpm's pre-run check would otherwise treat the build's own writes (a filtered install prunes the lockfile, later `COPY` and `chown` touch the manifests) as drift and try to reinstall as the unprivileged user, which fails. Developers on the host keep the check.

A hosted pipeline runs `scripts/ci.sh --cold`, which resets the stack first as a fresh runner would. Locally the cold run keeps the local app's data: `scripts/stack.sh reset --keep-data` deletes every volume except PostgreSQL's, the object store's (whose objects the database references, [0020](0020-object-storage-uploads.md)), OpenBao's with its local unseal key, and the root CA. On a fresh runner there is nothing to keep, so the start is fully cold there; `scripts/stack.sh reset` remains the way to wipe everything locally. **The GitHub Actions workflow is not written yet**: the repository has no remote, and GitHub's hosted Ubuntu images ship an older Podman than the stack is built and verified on (6.1). The workflow is added when the repository is published, either installing a current Podman on a hosted runner or on a self-hosted one; it calls the script and holds no logic of its own.

Lint is ESLint with type-aware `typescript-eslint` rules for every TypeScript package. The client boundary is checked by dependency-cruiser, because ESLint rules see one file at a time and the boundary is about whole import chains.

Two CI-specific points:

- **Real NFS for the backup test.** The runner is a disposable VM with root, so the job installs an NFS server on the runner, mounts its export, and bind-mounts it into the `backup` container at `/srv/backups`: `sudo scripts/ci-nfs-runner.sh [--cold]` does that (Debian/Ubuntu, Arch or Fedora), exports with `root_squash`, checks that root is squashed, runs `scripts/ci.sh` as the invoking user with `BACKUP_TARGET` set to the mount, and removes the export afterwards. Local development uses a named volume instead, because rootless Podman can neither mount NFS nor run an NFS server.
- **Secrets are random per run.** CI initialises its own OpenBao and fills it with generated values ([0023](0023-secrets-management.md)). No real secret or decryption key exists in GitHub Actions.
- **Test objects go with test databases.** The integration tests and the end-to-end api each have their own uploads bucket; the Vitest global setup and `scripts/stack.sh e2e` empty it at the start and end of a run, as they drop their databases ([0020](0020-object-storage-uploads.md)). `empty-bucket.js` refuses the production buckets whatever its configuration says.

## Consequences

- Integration and end-to-end tests need the container stack, so the test suite is not runnable without it. This is the accepted cost of testing against real infrastructure.
- CI wall time is dominated by container startup, with Keycloak the slowest to become healthy.
- The NFS backup path is exercised on every pipeline but not on developer machines; a regression in NFS handling surfaces in CI, not locally.
