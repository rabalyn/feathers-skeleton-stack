# 0021: Role-based authorization with `feathers-casl` (owner, admin, user)

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Authorization model](../technical-architecture.md#authorization-model)
- Related: [0008](0008-feathersjs-v5-api.md), [0019](0019-single-app-context.md), [0023](0023-hybrid-jwt-refresh-cookie.md), [0059](0059-production-bootstrap.md), [0063](0063-stats-endpoint.md)

## Context

The application needs a clear permission boundary for CRUD, uploads, exports, and administrative functions, without multi-tenancy.

## Decision

Use an `owner + admin + user` role model, implemented with `feathers-casl` for explicit service-level authorization.

## Consequences

- Authorization rules are declared centrally and enforced in Feathers hooks.
- CASL conditions must translate correctly into Knex queries for list/find operations.
- The role model can be extended later without multi-tenant rework.

## ToDos

- ToDo: [Contradiction] The production bootstrap creates "a single initial admin account" (ADR 0059), but the role model has `owner` above `admin`. Is the initial account the owner? How else does an owner come to exist?
- ToDo: [Contradiction] `/stats` needs "a dedicated admin/observability permission" (ADR 0063), which isn't one of the three roles. Is it a permission granted to admin/owner, a fourth role, or a flag?
- ToDo: [Missing] A permission matrix per role and service: users, document/profile, uploads, exports, stats, session management (logout-all for other users?), and role assignment.
- ToDo: [Clarify] How roles are stored (single role column or multiple), who may change them, how many owners are allowed, and whether a role change revokes sessions or applies before the 5-minute access token expires (ADR 0023).
- ToDo: [Missing] Authorization of real-time events via Feathers channels. `feathers-casl` offers channel helpers, but no decision exists (ADR 0008).
- ToDo: [Verify] `feathers-casl` compatibility with Feathers v5 and `@feathersjs/knex`, and whether the frontend reuses the same ability rules (shared through `packages/contracts`?).
