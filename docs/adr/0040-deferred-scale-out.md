# 0040: Defer scale-out (separate database/Valkey nodes, multiple hosts)

- Status: Proposed
- Date: 2026-09-14
- Scope: Deferred
- Source: [Technical architecture › Runtime Topology, Production orchestration](../technical-architecture.md#production-orchestration)
- Related: [0001](0001-production-valkey.md), [0028](0028-daily-maintenance-job.md), [0034](0034-single-host-rootless-quadlet.md), [0038](0038-host-built-images-no-registry.md)

## Context

The initial deployment is a single host. Several documents mention later scaling options without committing to them.

## Decision

A separate PostgreSQL node and a separate Valkey node are future scaling options. Move to multiple application hosts or a managed container platform when availability requirements exceed a single-host design. Until then, all services run on one host.

## Consequences

- No distributed-systems complexity in v1.
- Some decisions (in-process jobs, host-built images, host-managed secrets) will need revisiting at scale-out.

## ToDos

- ToDo: [Missing] No measurable triggers (availability target, load, data volume) are defined for any scale-out step.
- ToDo: [Contradiction] ADR 0001 justifies Valkey by consistency "across API instances", but no multi-instance API is planned. Multiple instances would also need a Socket.io/Feathers event-sync adapter (for example `feathers-sync`), which isn't mentioned.
- ToDo: [Clarify] Which constraints apply now to keep scale-out cheap (stateless API, no local file storage, no single-instance schedulers, ADR 0028).
