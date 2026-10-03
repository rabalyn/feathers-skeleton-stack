# 0026: MCP servers as local development tooling, not a product surface

- Status: Accepted
- Date: 2026-09-27
- Scope: Required (v1)
- Related: [0001](0001-one-stack-every-environment.md), [0002](0002-service-inventory-and-networks.md), [0006](0006-feathersjs-typescript-api.md), [0008](0008-authentication-saml2-ldap.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0014](0014-frontend-quasar-vue.md), [0015](0015-testing-vitest-playwright.md), [0016](0016-nginx-and-tls-everywhere.md), [0018](0018-owasp-security-baseline.md), [0020](0020-object-storage-uploads.md), [0022](0022-observability-and-alerting.md), [0023](0023-secrets-management.md)

## Context

Coding agents do better work when they read documentation for the versions actually installed rather than answering from memory, and when they can look at the real UI instead of guessing its structure. A test or a component an agent writes against an imagined page is wrong in ways that only show later. The Model Context Protocol (MCP) is how agents are given such access.

The existing decisions constrain how that can happen:

- Only Nginx publishes ports ([0002](0002-service-inventory-and-networks.md)). A tool on the developer's host reaches nothing else.
- Credentials must not be reachable by tooling with access to the working directory, coding agents included ([0023](0023-secrets-management.md)).
- Whatever a tool returns enters the agent's context and is sent to its LLM provider. For personal data that is a transfer [0013](0013-gdpr-export-and-retention.md) gives no basis for.
- Every server is code that takes input steered by an LLM, and an image is attack surface for as long as it runs. When this was decided, the available images of the Grafana, PostgreSQL and Valkey servers carried between 3 and 189 HIGH or CRITICAL findings with fixes available; the PostgreSQL one had not been released for sixteen months.
- A documentation server for the wrong version is worse than none, because it gives confident, wrong answers.

## Decision

### What MCP is for

MCP is **development tooling**: it lets a developer's coding agent read the documentation of the installed frontend framework and drive the local UI in a browser. Nothing in the product speaks MCP, and the api exposes no MCP endpoint. Whether a product built on this skeleton offers its own services over MCP is that product's decision (see the README's *Not yet decided*).

### The servers

Two, chosen for what they prevent: frontend code written against a Quasar API from memory, and end-to-end tests written against a page nobody looked at.

| Server | Implementation | Runs as | Reaches | Credential |
| --- | --- | --- | --- | --- |
| `quasar` | `@quasar/mcp`, a pinned dev dependency of the web app | Host process, stdio, from `node_modules`, with `NO_UPDATE_NOTIFIER` so it never asks the registry | Nothing; serves the docs and component API shipped inside the installed `quasar` and `@quasar/app-vite`, offline | None |
| `playwright` | The MCP server that ships in `playwright-core`, started by `e2e/mcp-server.js` as `@playwright/mcp`'s own entry point does, headless Chromium, isolated profile | The `mcp-browser` container, which is the `e2e` image idling | Nginx alone, on the internal network `mcp-edge`; `app.localhost`, `idp.localhost` and `netbox.localhost` ([0031](0031-netbox-locations.md), recorded 2026-10-03) map to it, and it trusts the local CA through its NSS store like `e2e` ([0015](0015-testing-vitest-playwright.md)) | None; logs in as the seeded test users, whose passwords are committed fixtures ([0008](0008-authentication-saml2-ldap.md)) |

The Playwright server runs on the `playwright-core` the end-to-end suite already uses, so its browser is the image's own, it adds no image and no package to scan, and Renovate moves it with `@playwright/test` as one group. `@playwright/mcp` itself is not installed: every release pins an alpha of Playwright whose browsers the image does not have.

`mcp-edge` holds Nginx and `mcp-browser` and nothing else, and is `internal`: the browser reaches the local origins and has no route to the internet. An agent steered into opening an outside page gets a network error, and a page in it cannot send what it sees anywhere. What the logged-in user may do is bounded by CASL like any browser ([0011](0011-casl-role-authorization.md)).

### Where they run

**Locally only.** `mcp-browser` carries the `local` profile, like `dozzle`: every `scripts/stack.sh up` starts it, it never reaches the generated Quadlet units, and `mcp-edge` is dropped from them with it. It never exists in production ([0001](0001-one-stack-every-environment.md)). The local stack holds only seeded and generated data, and that is what makes it acceptable for tool results to leave for an LLM provider. Production data is never loaded into a local stack.

### How they run

- The coding agent starts each server over **stdio**, declared in a committed `.mcp.json` at the repository root: `node` for `quasar`, `podman exec -i mcp-browser …` for `playwright`. The file holds no credential and no URL. No MCP port is published, and Nginx has no MCP virtual host ([0002](0002-service-inventory-and-networks.md), [0016](0016-nginx-and-tls-everywhere.md)).
- Versions are pinned like everything else, through the lockfile and the e2e image's digest, and updated through Renovate. No `npx …@latest`.
- **Approval is a committed, named allowlist.** Claude Code discovers `.mcp.json` by itself but connects a project server only once it is approved. `.claude/settings.json` lists this ADR's servers by name in `enabledMcpjsonServers`, not `enableAllProjectMcpServers`, so a server added to `.mcp.json` later stays pending until the allowlist names it too, and the review of that change sees both. Claude Code ignores a committed allowlist in a folder that is not trusted, so a fresh clone approves nothing until its developer trusts the folder.
- **`scripts/stack.sh mcp` checks them the way `.mcp.json` starts them**, and `scripts/ci.sh` runs it: Quasar answers an API lookup with no network at all, and the browser loads the app and the IdP over trusted TLS but cannot reach an outside address. CI therefore connects to them, as a check and nothing more.

### Using them

What a developer needs, in Claude Code's terminal and in the desktop app alike, since both read the same `.mcp.json` and settings:

1. Node on the `PATH` for `quasar`, and `pnpm install` done.
2. The local stack running (`scripts/stack.sh up`) and rootless `podman` on the `PATH` for `playwright`. With the stack down it shows as failed to connect, and `quasar` still works. An app started from the desktop may not inherit a shell's `PATH`.
3. The repository folder trusted once, in the trust dialog on first start. The allowlist then approves the servers without further prompts.
4. `/mcp` in a session, or `claude mcp list`, shows each server as connected, pending or failed. `claude mcp reset-project-choices` forgets earlier per-server choices.

An action such as a click answers with the page's state and a link to a snapshot file inside the container, which the agent cannot open; `browser_snapshot` returns the accessibility tree itself. Other MCP clients read `.mcp.json` differently or not at all; they are not configured by this repository.

### When an agent must use them

Having the servers available doesn't mean an agent uses them. Agents decide per session whether to look something up, and they don't read this ADR unless something points them to it. So the use is a rule, and `CLAUDE.md`, which agents load at the start of every session, states it and links here:

- **Before writing or changing frontend code that uses a Quasar component, plugin, directive or composable, or `@quasar/app-vite` configuration**, the agent looks up the parts it uses through `quasar` (`get_api` for props, slots, events and methods; `search_docs` and `get_page` for usage). It doesn't rely on memory, because memory may describe another Quasar version.
- **Before writing or changing an end-to-end test**, the agent opens the pages the test covers through `playwright` and reads them with `browser_snapshot`, so the test's locators come from the real UI.
- If a server fails to connect, the agent tells the developer and doesn't silently fall back to memory. For `playwright` the usual cause is a stack that isn't running (see *Using them*).

### What MCP is not used for

| Not used for | Why |
| --- | --- |
| Grafana, PostgreSQL, Valkey | Not provided for now: each would add an image with open findings, an agent and a credential into the stack, for what a developer already sees in Grafana and through `podman exec`. If one is added later, its boundary is a read-only login of its own, rendered by its own agent like every other service's ([0023](0023-secrets-management.md)); a server's own read-only mode is never the boundary, because such modes have been bypassed |
| OpenBao | Secrets never enter an agent's context ([0023](0023-secrets-management.md)) |
| Garage, object storage | Objects are people's files and leave only through an authorized api call ([0020](0020-object-storage-uploads.md)) |
| Podman, container control | No MCP server gets the Podman API socket. `dozzle`'s read-only view stays its only user ([0002](0002-service-inventory-and-networks.md)) |
| FeathersJS documentation | The only server (FeathersMCP) covers the v6 documentation and is marked inactive. This project is on v5 ([0006](0006-feathersjs-typescript-api.md)), so it would teach the wrong API. Revisited when Feathers is upgraded |
| Keycloak, LDAP | The realm and the directory are committed fixtures ([0008](0008-authentication-saml2-ldap.md)); `playwright` logs in through Keycloak like any user |
| The internet | `mcp-browser` has no route out; the agent's own web tools are the agent's business, not the stack's |
| Production, product features | See above |
| Replacing tests | A property checked through MCP that must stay true gets a Vitest or Playwright test ([0015](0015-testing-vitest-playwright.md)) |

Anything not listed here is not provided. Adding an MCP server amends this ADR.

## Consequences

- One more container on every local stack, on an image that is built and scanned anyway ([0018](0018-owasp-security-baseline.md)), and one more network. No agent, secret path or login is added.
- `e2e/mcp-server.js` imports `playwright-core`'s bundle entry points, as `@playwright/mcp` does. They are exported paths, but not a documented API; a Playwright upgrade that moves them fails `stack.sh mcp` in CI.
- Tool results go to the agent's LLM provider. Locally that is seeded data only, but it includes whatever the logged-in test user sees. The rule that production data never enters a local stack is what keeps this acceptable.
- A coding agent that can run `podman` can still `exec` into any container and read its `/run/secrets`, as it already could before this ADR. MCP does not widen that: [0023](0023-secrets-management.md)'s rule is about what an agent is handed, and no MCP configuration hands it a credential. Local values are random throwaway values.
- `mcp-browser` drives the real UI but is not the end-to-end suite: it works on the developer's `app` database at `app.localhost`, not on `app_e2e` ([0015](0015-testing-vitest-playwright.md)).
- An agent without Grafana, database or queue access reads those through the developer, or through `podman exec` where its permissions allow; that is the price of the smaller surface.
