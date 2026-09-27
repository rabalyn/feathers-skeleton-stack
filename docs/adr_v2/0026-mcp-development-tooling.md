# 0026: MCP servers as local development tooling, not a product surface

- Status: Accepted
- Date: 2026-09-27
- Scope: Required (v1)
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0004](0004-pgbouncer-pools.md), [0006](0006-feathersjs-typescript-api.md), [0008](0008-authentication-saml2-ldap.md), [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0014](0014-frontend-quasar-vue.md), [0015](0015-testing-vitest-playwright.md), [0016](0016-nginx-and-tls-everywhere.md), [0020](0020-object-storage-uploads.md), [0022](0022-observability-and-alerting.md), [0023](0023-secrets-management.md)

## Context

Coding agents do better work when they can read the running stack directly — query logs and metrics, look at rows and queues, drive the UI — and when they read documentation for the versions actually installed rather than answering from memory. The Model Context Protocol (MCP) is how agents are given such access.

The existing decisions constrain how that can happen:

- Only Nginx publishes ports ([0002](0002-service-inventory-and-networks.md)). A tool on the developer's host reaches nothing else.
- Credentials must not be reachable by tooling with access to the working directory, coding agents included ([0023](0023-secrets-management.md)). A connection string or token in an agent's configuration would break that.
- Whatever a tool returns enters the agent's context and is sent to its LLM provider. For personal data that is a transfer [0013](0013-gdpr-export-and-retention.md) gives no basis for.
- "Read-only" modes implemented inside MCP servers have not held: the reference PostgreSQL server is archived, and a widely used one enforced read-only with a keyword denylist that was bypassed. Only the database's own permissions are a boundary.
- A documentation server for the wrong version is worse than none, because it gives confident, wrong answers.

## Decision

### What MCP is for

MCP is **development tooling**: it lets a developer's coding agent inspect the local stack and read documentation that matches the installed versions. Nothing in the product speaks MCP, and the api exposes no MCP endpoint. Whether a product built on this skeleton offers its own services over MCP is that product's decision (see the README's *Not yet decided*).

### Where it runs

**Locally only.** The stack's MCP servers carry the `local` profile, like `dozzle`: every `scripts/stack.sh up` starts them, they never reach the generated Quadlet units, and they never exist in production. CI runners start them too, because `stack.sh` always runs the `local` profile, but nothing connects to them there ([0001](0001-one-stack-every-environment.md)).

The local stack holds only seeded and generated data, and that is what makes it acceptable for tool results to leave for an LLM provider. Production data is never loaded into a local stack.

### The servers

| Server | Implementation | Runs as | Reaches | Credential | Access |
| --- | --- | --- | --- | --- | --- |
| `quasar` | `@quasar/mcp`, a pinned dev dependency of the web app | Host process, stdio, from `node_modules` | Nothing; serves the docs and component API shipped inside the installed `quasar` and `@quasar/app-vite`, offline | None | Documentation |
| `mcp-grafana` | `grafana/mcp-grafana`, `--disable-write` | Container | Grafana on `grafana-edge`, where a person using Grafana sits | Token of a Grafana service account with the Viewer role, from `kv/mcp-grafana` | Read: dashboards, alerts, and Prometheus and Loki through Grafana's data sources |
| `mcp-postgres` | Postgres MCP Pro (`crystaldba/postgres-mcp`), restricted mode | Container | PgBouncer on `app-data`, database `app`; never the `db` network | Login `mcp_read`: `CONNECT`, schema `USAGE`, `SELECT`, `default_transaction_read_only = on`; from `kv/mcp-postgres` | Read |
| `mcp-valkey` | `awslabs/valkey-mcp-server`, `--readonly` | Container | Valkey on `app-data` | Valkey ACL user `mcp`: read commands on `rl:*` and `bull:*`, and `INFO` ([0010](0010-sessions-postgres-ratelimits-valkey.md)); from `kv/mcp-valkey` | Read |
| `mcp-browser` | `microsoft/playwright-mcp`, headless Chromium | Container | `edge` and `idp-edge`, like the `e2e` runner; trusts the local CA; uses `app.localhost` | None from OpenBao; logs in as the seeded test users, whose passwords are committed fixtures ([0008](0008-authentication-saml2-ldap.md)) | Whatever the logged-in user may do, bounded by CASL like any browser ([0011](0011-casl-role-authorization.md)) |

**Read-only is enforced by the credential, not by the server.** Each server's own read-only flag is kept as a second layer, but the boundary is the login's permissions. A server whose read-only mode fails can still do nothing that its login cannot. No server writes; `mcp-browser` changes data only as far as the user it logs in as may, through the api.

### How they run

- Each stack server is a long-running container with its own `<name>-agent`, which renders its credential into tmpfs as every other service's does ([0023](0023-secrets-management.md)). `mcp-browser` has no agent because it needs no secret.
- The coding agent starts a session over **stdio** with `podman exec -i <container> …`, declared in a committed `.mcp.json` at the repository root. That file holds no credential and no URL with one in it. No MCP port is published, and Nginx has no MCP virtual host ([0002](0002-service-inventory-and-networks.md), [0016](0016-nginx-and-tls-everywhere.md)).
- Versions are pinned like everything else: images by digest with the version in a comment, the npm package through the lockfile, and updates through Renovate. No `npx …@latest`.
- **Approval is a committed, named allowlist.** Claude Code discovers `.mcp.json` by itself but connects a project server only once it is approved. `.claude/settings.json` lists this ADR's servers by name in `enabledMcpjsonServers`, not `enableAllProjectMcpServers`, so a server added to `.mcp.json` later stays pending until the allowlist names it too, and the review of that change sees both. Claude Code ignores a committed allowlist in a folder that is not trusted, so a fresh clone approves nothing until its developer trusts the folder.

### Using them

What a developer needs, in Claude Code's terminal and in the desktop app alike, since both read the same `.mcp.json` and settings:

1. The local stack running (`scripts/stack.sh up`). The stack servers are `podman exec` into running containers; with the stack down they show as failed to connect, and the Quasar server still works.
2. Rootless `podman` on the `PATH` of the process that starts Claude Code. An app started from the desktop may not inherit a shell's `PATH`.
3. The repository folder trusted once, in the trust dialog on first start. The allowlist then approves the servers without further prompts.
4. `/mcp` in a session, or `claude mcp list`, shows each server as connected, pending or failed. `claude mcp reset-project-choices` forgets earlier per-server choices.

Other MCP clients read `.mcp.json` differently or not at all; they are not configured by this repository.

### What MCP is not used for

| Not used for | Why |
| --- | --- |
| OpenBao | Secrets never enter an agent's context ([0023](0023-secrets-management.md)) |
| Garage, object storage | Objects are people's files and leave only through an authorized api call ([0020](0020-object-storage-uploads.md)) |
| Podman, container control | No MCP server gets the Podman API socket. `dozzle`'s read-only view stays its only user ([0002](0002-service-inventory-and-networks.md)) |
| FeathersJS documentation | The only server (FeathersMCP) covers the v6 documentation and is marked inactive. This project is on v5 ([0006](0006-feathersjs-typescript-api.md)), so it would teach the wrong API. Revisited when Feathers is upgraded |
| Prometheus, Loki directly | Reached through Grafana, as people reach them ([0022](0022-observability-and-alerting.md)) |
| Keycloak, LDAP | Not provided for now. The realm and the directory are committed fixtures ([0008](0008-authentication-saml2-ldap.md)); `mcp-browser` logs in through Keycloak like any user |
| Writes | Application state changes through the api and migrations, and tests set it up for themselves |
| Production, CI jobs, product features | See above |
| Replacing tests | A property checked through MCP that must stay true gets a Vitest or Playwright test ([0015](0015-testing-vitest-playwright.md)) |

Anything not listed here is not provided. Adding an MCP server amends this ADR.

## Consequences

- Seven more containers on every local stack: four servers and three agents. That means more memory and a longer start, and CI starts them without using them. This was chosen over an opt-in profile so the tools are always there when an agent needs them.
- Tool results go to the agent's LLM provider. Locally that is seeded data only, but it includes everything a read-only login sees: `auth_sessions` rows, seeded audit events, and rate-limit keys that carry client addresses. The rule that production data never enters a local stack is what keeps this acceptable.
- A coding agent that can run `podman` can still `exec` into any container and read its `/run/secrets`, as it already could before this ADR. MCP does not widen that: [0023](0023-secrets-management.md)'s rule is about what an agent is handed, and no MCP configuration hands it a credential. Local values are random throwaway values.
- Two new logins (`mcp_read` and the Valkey user `mcp`), a Grafana service account and three secret paths, all created by the local setup and none of them in production.
- The Postgres login goes through PgBouncer in transaction mode ([0004](0004-pgbouncer-pools.md)), so server features that need a session, such as prepared statements across calls or `SET` that persists, are unavailable to it. Reads do not need them.
- `mcp-browser` drives the real UI but is not the end-to-end suite: it works on the developer's `app` database, not on `app_e2e` ([0015](0015-testing-vitest-playwright.md)).

