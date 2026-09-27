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
| `mcp-idp` | A Keycloak Admin REST API server (see *Open questions*) | Container | Keycloak on `idp-edge` | Confidential client `mcp` in the `feathers` realm with `view-realm`, `manage-realm` and `manage-clients`; not a master-realm admin, no `manage-users`; from `kv/mcp-idp` | **Read and write** realm and client configuration |

**Read-only is enforced by the credential, not by the server.** Each server's own read-only flag is kept as a second layer, but the boundary is the login's permissions. A server whose read-only mode fails can still do nothing that its login cannot.

**Keycloak is the one writable server**, because adjusting IdP settings is a real development task. Its source of truth stays the committed realm import ([0008](0008-authentication-saml2-ldap.md)). Keycloak imports that file only on first start, so a change made through `mcp-idp` lives only in the `idp-data` volume: `reset` loses it, and CI never sees it. A realm change is finished only when it is in `containers/idp/realm-feathers.json` and survives `scripts/stack.sh reset`. The MCP is for trying a setting out; the file is where it lands. Users are not managed there, because the LDAP seed is their source. The production IdP is the university's, so nothing done here reaches production.

### How they run

- Each stack server is a long-running container with its own `<name>-agent`, which renders its credential into tmpfs as every other service's does ([0023](0023-secrets-management.md)). `mcp-browser` has no agent because it needs no secret.
- The coding agent starts a session over **stdio** with `podman exec -i <container> …`, declared in a committed `.mcp.json` at the repository root. That file holds no credential and no URL with one in it. No MCP port is published, and Nginx has no MCP virtual host ([0002](0002-service-inventory-and-networks.md), [0016](0016-nginx-and-tls-everywhere.md)).
- Versions are pinned like everything else: images by digest with the version in a comment, the npm package through the lockfile, and updates through Renovate. No `npx …@latest`.

### What MCP is not used for

| Not used for | Why |
| --- | --- |
| OpenBao | Secrets never enter an agent's context ([0023](0023-secrets-management.md)) |
| Garage, object storage | Objects are people's files and leave only through an authorized api call ([0020](0020-object-storage-uploads.md)) |
| Podman, container control | No MCP server gets the Podman API socket. `dozzle`'s read-only view stays its only user ([0002](0002-service-inventory-and-networks.md)) |
| FeathersJS documentation | The only server (FeathersMCP) covers the v6 documentation and is marked inactive. This project is on v5 ([0006](0006-feathersjs-typescript-api.md)), so it would teach the wrong API. Revisited when Feathers is upgraded |
| Prometheus, Loki directly | Reached through Grafana, as people reach them ([0022](0022-observability-and-alerting.md)) |
| LDAP | The directory is a committed seed. Federated users are visible through `mcp-idp` |
| Writes other than Keycloak configuration | Application state changes through the api and migrations, and tests set it up for themselves |
| Production, CI jobs, product features | See above |
| Replacing tests | A property checked through MCP that must stay true gets a Vitest or Playwright test ([0015](0015-testing-vitest-playwright.md)) |

Anything not listed here is not provided. Adding an MCP server amends this ADR.

## Consequences

- Nine more containers on every local stack: five servers and four agents. That means more memory and a longer start, and CI starts them without using them. This was chosen over an opt-in profile so the tools are always there when an agent needs them.
- Tool results go to the agent's LLM provider. Locally that is seeded data only, but it includes everything a read-only login sees: `auth_sessions` rows, seeded audit events, and rate-limit keys that carry client addresses. The rule that production data never enters a local stack is what keeps this acceptable.
- A coding agent that can run `podman` can still `exec` into any container and read its `/run/secrets`, as it already could before this ADR. MCP does not widen that: [0023](0023-secrets-management.md)'s rule is about what an agent is handed, and no MCP configuration hands it a credential. Local values are random throwaway values.
- Keycloak settings changed through MCP drift from the realm file until someone writes them back. `reset` makes that drift visible rather than silent.
- Three new logins (`mcp_read`, the Valkey user `mcp`, the Keycloak client `mcp`), a Grafana service account and four secret paths, all created by the local setup and none of them in production.
- The Postgres login goes through PgBouncer in transaction mode ([0004](0004-pgbouncer-pools.md)), so server features that need a session, such as prepared statements across calls or `SET` that persists, are unavailable to it. Reads do not need them.
- `mcp-browser` drives the real UI but is not the end-to-end suite: it works on the developer's `app` database, not on `app_e2e` ([0015](0015-testing-vitest-playwright.md)).

## Open questions

- Which Keycloak MCP implementation. None comes from the Keycloak project, and several community servers exist. The choice is made when `mcp-idp` is built, and it must meet these criteria: authentication with client credentials, configurable access modes that allow configuration writes without user management, and active maintenance.
