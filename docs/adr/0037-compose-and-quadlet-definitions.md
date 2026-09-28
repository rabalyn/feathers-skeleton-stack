# 0037: Define local/CI topology in `compose.yaml` and production in Quadlet units

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Rootless Podman](../technical-architecture.md#rootless-podman)
- Related: [0003](0003-local-vs-containerized-frontend.md), [0034](0034-single-host-rootless-quadlet.md), [0053](0053-local-development-environment.md), [0054](0054-test-only-nginx.md), [0056](0056-github-actions-ci.md)

## Context

Local and CI environments need an easy multi-container topology. Production needs systemd lifecycle management and secret handling.

## Decision

`compose.yaml` defines local and CI services only and works with Podman Compose or an equivalent Compose-compatible tool. Production uses explicit systemd Quadlet units under `deploy/quadlet/`. Both definitions share image tags, environment variable names, health checks, and dependency contracts; production lifecycle and secret handling stay systemd-specific.

Local/CI services:

- `db`: PostgreSQL with a named persistent volume and a health check.
- `pgbouncer`: PgBouncer with explicitly configured pool size and pool mode.
- `valkey`: Valkey for authentication rate-limit state, with ephemeral storage.
- `s3`: S3-compatible object storage (such as MinIO) on a named Podman volume.
- `api`: FeathersJS API, depending on database readiness rather than container start.
- `web`: production frontend image with static assets.
- `nginx`: local/test reverse proxy, static asset server, API router, WebSocket endpoint.
- `logs`: Dozzle, connected to the rootless Podman API socket read-only.

Use Compose profiles where local and CI needs differ. Production configuration never relies on source-code bind mounts or development servers.

## Consequences

- Two service definitions must be kept consistent by hand or tooling.
- Developers get a one-command stack; production gets systemd-native supervision.

## ToDos

- ToDo: [Missing] A mechanism that keeps Compose and Quadlet consistent (generation, a consistency test, or a review checklist). Drift is otherwise likely.
- ToDo: [Contradiction] Compose "defines local and CI services only", yet the `valkey` entry speaks of "ephemeral storage in local/CI **and production** profiles".
- ToDo: [Contradiction] `nginx` is described as a "static asset server", but `web` is the image holding the static assets, and the Nginx section says the test profile runs "the built web image behind the repository's test Nginx container". Decide whether test Nginx proxies to `web` (production-like) or serves files itself.
- ToDo: [Contradiction] `s3` is "backed by a persistent named Podman volume in local/CI", while "in development and CI, the object-storage volume is disposable".
- ToDo: [Clarify] "Podman Compose or an equivalent": `podman-compose` and `docker-compose` against the Podman socket differ in their support for profiles, health checks, and `depends_on` conditions. Pick one tool and a minimum version.
- ToDo: [Missing] The inventory lacks backup, Prometheus, Grafana, Loki, Alloy, exporters, and a mail-capture service. Yet CI must run backup-role, dump, and restore tests (ADR 0015, 0052), and local/CI backup tests use the `s3` service.
- ToDo: [Missing] Profile names and which services each profile contains (for example `dev`, `test`/`e2e`, `ci`).
- ToDo: [Clarify] Whether CI uses this `compose.yaml` or GitHub Actions `services:` containers (ADR 0056).
- ToDo: [Clarify] Which profile runs Dozzle, and the rootless socket path (`$XDG_RUNTIME_DIR/podman/podman.sock`).
