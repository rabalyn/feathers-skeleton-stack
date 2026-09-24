# 0007: Classify baseline requirements versus future enhancements

- Status: Proposed
- Date: 2026-09-14

## Context

The architecture mixes baseline requirements, recommendations, and future-state ideas in the same document. Examples include: required production services, optional later scale-out items, and enhancement ideas such as tracing, advanced rate limiting, or multi-host orchestration. Because the document is not explicit about classification, it becomes hard to tell what must exist for v1 and what is intentionally deferred.

ToDo: split required-initial implementation from future milestones and label each section accordingly.

## Decision

The architecture should distinguish three categories:

1. Required for the initial v1 implementation.
2. Required for the platform but conditionally enabled by feature use.
3. Explicitly deferred future work or enhancements.

This ADR is meant to make the document easier to audit and to reduce accidental overcommitment during early implementation.

## Consequences

- The team can tell what must be built before the first scaffold is considered viable.
- Future improvements such as tracing, registry adoption, or multi-host deployment remain visible but do not blur v1 scope.
- The project can make better release decisions when a feature is still an aspiration instead of a requirement.
- Documentation becomes easier to review because each requirement is classified instead of being described with equal weight.

ToDo: annotate each major section of the technical architecture with a status label such as required, conditional, or deferred.

## ToDos (review 2026-09-14)

- ToDo: [Clarify] ADRs 0008–0070 now carry a `Scope` field (Required / Conditional / Deferred) as a first classification pass. Review those values instead of annotating the architecture document (ADR 0069).
- ToDo: [Missing] The architecture uses at least four different milestones without defining them: "initial scaffold", "v1", "initial deployment", and "first production release" (for example the development-only email tokens in ADR 0026, and health/metrics "before the first production release" in ADR 0060). Define the milestones and their order, then classify against them.
- ToDo: [Clarify] "Advanced rate limiting", cited as an enhancement example in the context above, doesn't appear in the architecture document.
