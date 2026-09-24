# 0007: The typed client is exported from the API package and imported by the frontend

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0016, 0017, 0018
- Related: [0005](0005-typebox-schema-boundary.md), [0006](0006-feathersjs-typescript-api.md), [0014](0014-frontend-quasar-vue.md)

## Context

The frontend should call the API with compile-time type safety, and a breaking API change should fail the frontend build immediately. The previous plan introduced a separate `packages/contracts` package, which departs from what the Feathers v5 generator produces and creates a third place for types to drift.

## Decision

- `apps/api` exposes a dedicated client entry point (`apps/api/src/client.ts`, published as the `./client` subpath export of the workspace package). It exports the service interfaces, the TypeBox-derived types, and a `createClient()` factory.
- `apps/web` imports that entry point through the pnpm workspace link. There is no separate contracts package.
- The client entry point must not transitively import server-only code. Knex, `pg`, the SAML library, resolvers and hooks are forbidden there. This is enforced by a dependency boundary lint rule in CI, not by convention, because a violation ships a database driver into the browser bundle.
- Types are consumed as built output (`tsc` declaration files), so the frontend build does not typecheck the entire API source on every run.

## Repository layout

```text
.
├── apps/
│   ├── api/                 # FeathersJS application; exports ./client
│   └── web/                 # Vue + Quasar application
├── docs/
├── deploy/quadlet/          # Quadlet units generated from compose.yaml, plus production drop-ins
├── compose.yaml             # Single source of the service topology
├── containers/              # Containerfiles and service configuration
└── pnpm-workspace.yaml
```

Everything under `containers/` — Containerfiles, Nginx configuration, LDAP seed data, Keycloak realm import, the local CA script, OpenBao server configuration, policies and agent templates, backup scripts — is versioned with the application, because the parity rule ([0001](0001-one-stack-every-environment.md)) makes those files part of how the application runs, not incidental scaffolding.

## Consequences

- One definition of the contract, living where the Feathers generator already puts it.
- The API package becomes a dependency of the frontend, so its build must run first. The workspace handles ordering.
- The boundary lint rule is load-bearing; without it the arrangement is one careless import away from bundling `pg`.
