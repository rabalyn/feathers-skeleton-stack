# 0019: Single shared application context without multi-tenancy in v1

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1); tenancy Deferred
- Source: [Technical architecture › Authorization model, Initial v1 domain model](../technical-architecture.md#authorization-model)
- Related: [0020](0020-v1-domain-model.md), [0021](0021-casl-role-authorization.md)

## Context

Multi-tenancy adds tenant scoping to every query, permission, and metric. No product need for tenant isolation has been identified.

## Decision

v1 assumes a single shared application context. Tenant boundaries are added only when a real product need appears.

## Consequences

- Simpler schema, authorization rules, and queries.
- Adding tenancy later requires a data migration and changes to authorization, uniqueness constraints, metrics, and backups.

## ToDos

- ToDo: [Clarify] What "shared app context" means for data visibility: does every user see every document/profile, or only their own? This drives CASL rules (ADR 0021) and real-time channels (ADR 0008).
- ToDo: [Clarify] Whether any cheap preparation for later tenancy is wanted now, or explicitly none.
- ToDo: [Clarify] The word "owner" is used both for the top application role (ADR 0021) and for ownership of individual objects ("the API validates ownership and permissions", ADR 0044). Use distinct terms.
