# 0032: A system-info page shows what runs and which updates are out, from a daily check

- Status: Accepted
- Date: 2026-10-01
- Scope: Required (v1)
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0006](0006-feathersjs-typescript-api.md), [0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0018](0018-owasp-security-baseline.md), [0022](0022-observability-and-alerting.md), [0024](0024-background-jobs-bullmq.md)

## Context

A product built on this skeleton runs about twenty third-party components: PostgreSQL, PgBouncer, Valkey, OpenBao, Garage, Nginx, NetBox, Node, Prometheus, Loki, Grafana, Alloy, the exporters, restic, and the host's operating system. Each publishes patch releases and reaches end of life on its own schedule. Today nothing in a deployment shows which versions run or that a patch is out. Renovate opens pull requests against the repository, but it doesn't say which deployment still runs what, and it can't report that a release line is about to reach end of life.

GitLab's admin area is the model: it shows the version that runs, the versions of its dependencies, and whether an update is available. The same view, inside the application, tells an admin whether patches need to be deployed.

Knowing that an update exists needs information from outside the stack. Until now the application made no outbound request except to the IdP, the LDAP directory and the SMTP relay ([0018](0018-owasp-security-baseline.md), A10), and Grafana's own update check is off. This ADR adds one more outbound path, on purpose and narrowly.

## Decision

### The page

- `/system-info` in the application, for **admins only**: a catalogue permission `system-info.read` ([0011](0011-casl-role-authorization.md)), which only `admin` holds as seeded. Read-only, except for running the update check now (below).
- One row per component that production runs (the units in `deploy/quadlet/`), plus the host's operating system. Local-only services (Mailpit, Dozzle, Keycloak, the LDAP fixture, the e2e and MCP containers) aren't listed: they never run in production.
- Per row: the component, its image, the **declared** version (what this build pins), the **running** version (what the component reports), the newest **patch** of the running line, the newest **minor**, the newest **major**, and the **end of life** of the running line where known. A newer patch is the highlighted case, "deploy this"; a newer minor or major is shown but is a planning matter.
- When declared and running differ, the row says so. That happens when an image was rebuilt but its service not restarted, or when a production drop-in overrides an image.
- The page shows when the last check ran and, per row, why a value is missing (not reported, not known to the source, check failed, check off).

### Declared versions: generated from the repository, checked for drift

- `scripts/inventory.sh` writes `apps/api/src/system/inventory.ts` from the files that already pin every image: the `# version` comments in `compose.yaml` and the `tag@digest` lines in the Containerfiles, the same patterns Renovate's managers read. A pin without a tag takes its version from an adjacent comment that is a bare version or names the image (Garage's `# v2.4.1`, `# restic 0.19.1`). The script (`scripts/inventory.mjs`, no dependencies) runs in the pinned Node image without a network.
- The components are listed in that script, each with the files that pin it, which must agree (the Alpine base of PgBouncer, of the S3 front and of the api's runtime, which must also be the release the Node image is built on). The script fails when an image a unit in `deploy/quadlet/` runs, or that a Containerfile of a locally built production image pins, belongs to no component.
- `scripts/inventory.sh --check` fails when the file differs from a fresh run. It joins the static checks in `scripts/ci.sh`, like the Quadlet drift check.
- An image pinned by digest alone needs such a comment; without one the script fails.
- PgBouncer is installed from Alpine packages and has no version in the repository. It gets its own row, with the version it reports, while the Alpine base image is a row of its own with its update and end-of-life columns. The Nginx in front of Garage is an Alpine package as well, and is covered by that Alpine row; the main Nginx runs the official image and is a row of its own.

### The application's own version

Production builds its images on the host (`localhost/feathers-*:dev`), so there is no release number. The page shows the **git commit** the api image was built from instead, with the commit's time and whether the work tree had uncommitted changes. `scripts/stack.sh` passes them as build arguments (`APP_COMMIT`, `APP_COMMIT_TIME`, `APP_DIRTY`), set in the image's last stage, which the backup image doesn't inherit. The commit time was chosen over the build time: a build time makes every build a new image, so every `stack.sh up` would restart the api, the worker and migrate without a code change. A build outside a git checkout shows "unknown". Decided 2026-10-01.

Beside it the page shows the **public origin** the api runs with (`PUBLIC_ORIGIN`), the address every link the application hands out starts with, mails included. Read-only: it is deployment configuration ([0025](0025-runtime-settings.md)). Decided 2026-10-02.

### Running versions: asked live when the page loads

The api gathers them on each page load, with a short timeout per source, so the page shows what runs right now:

| Source | Components |
|---|---|
| Prometheus' query API (`*_build_info`, `pg_static`, `pgbouncer_version_info`, `node_os_info`, …) | PostgreSQL, PgBouncer, Garage, Grafana, Loki, Prometheus, the exporters, the host OS |
| Valkey `INFO server` (`valkey_version`; the exporter reports only the Redis compatibility version) | Valkey |
| NetBox `GET /api/status/` | NetBox |
| The process itself | Node, the api |

The api is already on the `observability` network. Its query to Prometheus is a new hop and, like every hop, uses TLS verified against the CA root ([0022](0022-observability-and-alerting.md)). OpenBao, Alloy, blackbox and Nginx report no version to any of these sources and show their declared version only.

### Available updates: a daily check in the worker, with a fixed allowlist

- A job scheduler on the worker's `maintenance` queue runs the check once a day at night ([0024](0024-background-jobs-bullmq.md)), and once when the worker starts if the last result is older than a day.
- For each component it lists the tags of its image's repository in the registry and compares them with the declared tag. Tags count as versions when they parse as a numeric version with an optional `v`; a candidate must carry the same suffix as the declared tag (`-alpine`, `-trixie-slim`), and pre-releases (`rc`, `beta`, `alpha`) are ignored. A component whose tags follow another scheme (NetBox's `v4.7.2-5.1.1`: the upstream version, then the image's own revision) declares its rule in code.
- End-of-life dates come from endoflife.date for the products it knows: PostgreSQL, Valkey, Node.js, Grafana, Loki, Prometheus, Nginx, OpenBao, Alpine, Debian, and the usual server distributions for the host. For NetBox, Garage, PgBouncer, restic and Alloy the column stays empty, stating that no source is known.
- The outbound hosts are a **fixed allowlist in code**: `registry-1.docker.io` and `auth.docker.io` (Docker Hub), `quay.io`, and `endoflife.date`. Requests go **directly**, with no proxy: a host without a route out gets "check failed: no route". Responses are parsed as data and never followed elsewhere, and each request has a timeout and a size cap.
- The check can be switched off in deployment configuration (`UPDATE_CHECK=off`). The page then says so instead of showing stale data.
- An admin can run the check **now** with a button on the page instead of waiting for the night: the `update-checks` service's `create`, under its own catalogue permission `system-info.check`, which only `admin` holds as seeded, so a role can read the page without starting outbound requests; no API token may carry it ([0029](0029-api-tokens.md)). It queues the check on the `maintenance` queue under one job id, run once without retries. It is **refused while a check runs or waits to** (queued, running, or the daily one waiting for a retry; not the scheduler's next run at night), so Docker Hub's anonymous limits are never spent on two runs at once, and refused when the check is off. The report says whether a check is under way; while somebody who reads the page is connected, the api follows the check's jobs and publishes a `check` event with `running` to the page's subject channel ([0012](0012-role-scoped-channels.md)) when one starts or ends, however it was started, and the page reads the report again when one has ended. The page's other button only reloads the report. Decided 2026-10-01.
- Results are stored in PostgreSQL (one row per component: latest patch, minor and major, end of life, checked at, error), so the page and the metrics read the same state and a worker restart loses nothing.

### Metrics and alerts

The worker exports, computed from the stored results on each scrape:

- `stack_update_available{component, kind="patch"|"minor"|"major"}`: 1 while a newer version of that kind exists, with the first time it was seen kept in the table;
- `stack_eol_timestamp_seconds{component}` for the running line;
- `stack_update_check_last_success_timestamp_seconds`.

Grafana mails the operators ([0022](0022-observability-and-alerting.md)) through three rules, with thresholds confirmed on 2026-10-01:

- **Patch available:** for 7 days.
- **End of life near:** the running line reaches end of life within 90 days.
- **Update check failing:** no successful check for 3 days. Otherwise a check that stopped working would look like "everything is current".

Minor and major updates don't alert.

### What this does not do

- No vulnerability scanning at runtime. Trivy in CI stays the source for findings in images ([0018](0018-owasp-security-baseline.md)), and this page doesn't repeat them.
- No npm dependency versions: Renovate covers those, and the page would grow long without telling an admin anything they could act on in production.
- Nothing is updated automatically. Deploying stays a person's decision.

## Consequences

- Admins see in one place what runs, what is behind, and what is about to lose support. Operators get a mail when a patch has waited a week, without having to visit the page.
- [0018](0018-owasp-security-baseline.md)'s A10 row gains four hosts, fixed in code and never from user input. This is the first outbound request to a third party; it carries no data about the deployment except the source address and the image names it asks about, which are public anyway.
- The check depends on Docker Hub's anonymous rate limits. One daily run lists tags for about fifteen repositories, far below them. A repository with thousands of tags (`library/node`) needs several pages per run.
- A tag the parser misreads gives a wrong "update available". The unit tests pin the comparison against real tag lists, and a component whose scheme doesn't fit declares its own rule.
- The inventory is one more generated file with a drift check. Adding an image to `compose.yaml` without regenerating it fails CI, which is the point. Renovate bumps pins without running scripts, so its image pull requests fail this check until `scripts/inventory.sh` is run on them, as they already do for `scripts/quadlet.sh`, whose units carry the digests too. The reviewer regenerates both on the branch, and the PR body names the command ([0018](0018-owasp-security-baseline.md)).
- Without a route to the internet, the page still shows declared and running versions, and the update columns say why they're empty.
