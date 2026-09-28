# 0020: v1 domain model of shared-app users plus a basic document/profile object

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Initial v1 domain model](../technical-architecture.md#initial-v1-domain-model)
- Related: [0002](0002-object-storage-v1.md), [0019](0019-single-app-context.md), [0021](0021-casl-role-authorization.md), [0027](0027-activity-audit-events.md), [0044](0044-api-mediated-object-access.md)

## Context

The first scaffold needs a real CRUD surface to exercise authentication, authorization, real-time updates, uploads, and exports, without designing a large domain model up front.

## Decision

The v1 domain model is a shared-app user plus a basic document/profile object. It provides a CRUD surface and supports upload and export permissions without tenant boundaries.

## Consequences

- End-to-end tests, audit events, and metrics have concrete resources to work with.
- The model will be extended once actual product requirements are known.

## ToDos

- ToDo: [Clarify] "Document/profile object" is ambiguous. Is it a document, a user profile, or one entity serving both? Define name, fields, ownership, and cardinality (one profile per user, or many documents per user).
- ToDo: [Contradiction] The domain model and S3 section say storage is added only "when an upload/export feature actually needs them", while the S3 section also says "v1 includes uploads and exports" (see ADR 0002). Are uploads attached to this object in v1?
- ToDo: [Clarify] What an export is: which data, which format (CSV, PDF, JSON), synchronous or background generation, and how long generated exports are kept (ADR 0046).
- ToDo: [Clarify] Deletion semantics (hard or soft delete) and the effect on stored objects and backups (ADR 0049).
- ToDo: [Clarify] Personal-data obligations (access, export, erasure) for the profile. Is the export feature meant to cover data-subject export?
