# 0006: FeathersJS v5 API in TypeScript on Koa, WebSocket-only real-time

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0008, 0009, 0010
- Related: [0005](0005-typebox-schema-boundary.md), [0007](0007-typed-client-from-api.md), [0008](0008-authentication-saml2-ldap.md), [0012](0012-role-scoped-channels.md), [0022](0022-observability-and-alerting.md), [0023](0023-secrets-management.md), [0024](0024-background-jobs-bullmq.md), [0025](0025-runtime-settings.md)

## Context

The API serves a Quasar frontend over REST and WebSocket, shares typed contracts with it, and has to accommodate a SAML2 browser redirect flow that is not shaped like a service call.

## Decision

- **FeathersJS v5** with **TypeScript** throughout, **ESM** modules, compiled with `tsc` for the production image.
- **Koa** as the HTTP framework (`@feathersjs/koa`). Feathers v5 supports Koa and Express; Koa is the current recommendation and its middleware model suits cookie handling and streaming better.
- SAML2 needs real HTTP routes, not services, because the identity provider redirects a browser to them: `/auth/saml/login`, `/auth/saml/acs` (POST assertion consumer), `/auth/saml/metadata`, `/auth/saml/logout`. These are Koa routes mounted alongside the Feathers application. The SAML library is wrapped in a custom Feathers `AuthenticationStrategy` rather than Passport, so there is one authentication abstraction in the codebase rather than two ([0008](0008-authentication-saml2-ldap.md)).
- **Socket.io with the WebSocket transport only.** HTTP long-polling fallback is disabled (`transports: ['websocket']`), which keeps the Nginx proxy configuration to a single upgrade path and avoids sticky-session concerns.
- **TypeScript strict mode**, plus `noUncheckedIndexedAccess`. `noImplicitAny` is not listed separately because `strict` already enables it.
- **Node.js 24 LTS**, **pnpm** pinned through the root `package.json` `packageManager` field. A single pnpm workspace holds `apps/api` and `apps/web`.
- **Deployment configuration** (hostnames, endpoints, secret file paths) comes from environment variables and `*_FILE` secret files ([0023](0023-secrets-management.md)), validated at startup against a TypeBox schema. The process exits on missing or malformed configuration rather than starting in a half-configured state. **Operational settings** (retention, quotas, limits, schedules) are runtime settings in PostgreSQL ([0025](0025-runtime-settings.md)).
- The API listens on two ports: the public one behind Nginx, and an **internal port** serving `/metrics` and the health and readiness endpoints, reachable only on the `observability` network and outside the Feathers authentication pipeline ([0022](0022-observability-and-alerting.md)). The only unauthenticated liveness signal on the public port is `GET /api/ping`, which returns a constant and reveals nothing about internal state.
- The `worker` runs the same image with a different entry point ([0024](0024-background-jobs-bullmq.md)), sharing services, schemas and configuration code.

## Consequences

- Hooks give one place to enforce authentication, validation, authorization and audit for both transports.
- The project depends on the Feathers ecosystem (`@feathersjs/knex`, `@feathersjs/typebox`, `feathers-casl`, `feathers-pinia`) staying mutually compatible.
- Disabling polling means a client on a network that blocks WebSocket upgrades cannot use real-time features at all. Acceptable on a university network.
- Mixing Koa routes and Feathers services means two request styles in one codebase; the SAML routes are the only place this occurs.
- `feathers-casl`'s current release targets Feathers 5 and CASL 6, so the authorization design in [0011](0011-casl-role-authorization.md) rests on a supported combination.
