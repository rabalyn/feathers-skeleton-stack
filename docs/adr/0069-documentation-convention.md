# 0069: Documentation convention (README, architecture overview, ADRs)

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Purpose, Documentation Convention](../technical-architecture.md#documentation-convention)
- Related: [0007](0007-requirement-classification.md), [README](README.md)

## Context

Architecture knowledge must be findable, current, and traceable to the reasons behind it.

## Decision

- `README.md`: what the project is, prerequisites, quick start, common commands, and links into `docs/`.
- `docs/technical-architecture.md`: the current system shape and operational guidance.
- `docs/adr/NNNN-short-title.md`: one decision per ADR when a choice has meaningful alternatives or long-term impact. Each ADR contains `Status`, `Context`, `Decision`, and `Consequences`.
- The architecture document focuses on the current intended system and links to ADRs for historical context.
- Code comments explain only non-obvious implementation details and don't duplicate this documentation.

## Consequences

- Decisions have a stable, linkable home.
- Two places (overview and ADRs) must be kept consistent.

## ToDos

- ToDo: [Contradiction] The architecture document's Purpose says "decisions should be updated here… with the reason and date captured in the relevant section", while the convention puts decisions and their history into ADRs. Now that every decision is an ADR, define the architecture document's remaining role (for example a short overview that links ADRs) and remove duplicated decision text to prevent drift.
- ToDo: [Clarify] The ADRs use extra fields beyond the convention (`Date`, `Scope`, `Source`, `Related`, a `ToDos` section). Adopt them as the official template (for example `docs/adr/template.md`)?
- ToDo: [Missing] Status lifecycle (Proposed → Accepted → Superseded/Deprecated), who accepts an ADR, and whether an ADR can be Accepted while it still has open ToDos. ADRs 0001–0003 are marked Accepted but contain open ToDos.
- ToDo: [Contradiction] The architecture document is marked "Proposed" while some ADRs derived from it are "Accepted".
- ToDo: [Clarify] "When a choice has meaningful alternatives": most ADRs don't record the alternatives considered. Add an "Alternatives" section?
- ToDo: [Clarify] Where runbooks (restore, rollback, bootstrap, release) live.
