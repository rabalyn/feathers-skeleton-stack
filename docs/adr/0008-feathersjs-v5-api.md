# 0008: Use FeathersJS v5 with TypeScript for the API

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Goals, Backend](../technical-architecture.md#backend)
- Related: [0012](0012-knex-adapter-and-migrations.md), [0013](0013-typebox-validation-boundary.md), [0021](0021-casl-role-authorization.md), [0023](0023-hybrid-jwt-refresh-cookie.md)

## Context

The project needs an API backend that serves both REST and real-time clients, integrates with authentication and authorization hooks, and can share typed contracts with a Vue frontend.

## Decision

Build the API with Node.js and FeathersJS v5. Use TypeScript for application code, configuration, and shared contracts. Services are exposed over REST and a WebSocket transport through the Feathers transport layer.

## Consequences

- Hooks give a single place for authentication, validation, authorization, and audit behaviour.
- The frontend can use the Feathers typed client and `feathers-pinia` directly.
- The project depends on the Feathers ecosystem (`@feathersjs/knex`, `@feathersjs/authentication-*`, `feathers-casl`, `feathers-pinia`) staying compatible.
- Real-time events need explicit channel configuration so they reach only the connections allowed to see them.

## ToDos

- ToDo: [Missing] The HTTP framework under Feathers v5 is not chosen (Koa or Express). It affects cookie handling for the refresh endpoint (ADR 0023), multipart upload streaming (ADR 0044), and health/metrics middleware (ADR 0060, 0062).
- ToDo: [Clarify] The real-time transport is not named. Feathers v5 ships a Socket.io transport, which can fall back to HTTP long-polling; the architecture only talks about "WebSocket upgrade". Decide whether polling fallback is allowed.
- ToDo: [Missing] Channel configuration for real-time events is not defined: which authenticated connections receive which service events. It must follow the authorization model (ADR 0021).
- ToDo: [Clarify] Module format (ESM or CommonJS) and runtime strategy (compiled `tsc` output or a TypeScript loader) for the API image.
- ToDo: [Verify] Confirm Feathers v5 is still the supported major line when implementation starts, check the status of Feathers v6 pre-releases, and check ecosystem compatibility.
