# 0019: ADR convention for this directory

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0007, 0069
- Related: [README](README.md)

## Context

The previous ADR directory split a single architecture document into seventy files, one per paragraph, and appended an audit to each. The result was 433 open items across 70 files for a project with no business logic yet, several ADRs marked `Accepted` while still listing unresolved contradictions in their own text, and two incompatible field formats within one directory.

The problem was not rigour. It was that the split was mechanical rather than driven by decisions, and that recording an open question became a substitute for making a decision.

## Decision

### When an ADR exists

One ADR per decision that has meaningful alternatives and is expensive to reverse. Not one per paragraph, per service, or per configuration value. If a choice has no real alternative, it belongs in the README or in code, not here.

### Format

Every ADR carries the same fields, with no exceptions for older entries:

```markdown
# NNNN: Title in one line

- Status: Proposed | Accepted | Superseded
- Date: YYYY-MM-DD
- Scope: Required (v1) | Required (production) | Deferred
- Supersedes: (optional) which v1 ADRs this replaces
- Related: links to other v2 ADRs

## Context      — the forces, in a few sentences
## Decision     — what was decided, stated without hedging
## Consequences — what this costs, including the parts that hurt
## Open questions — (optional) genuinely undecided items only
```

### Rules that fix what went wrong in v1

- **A Decision section decides.** If it restates the alternatives and picks neither, the ADR is not ready and its status stays `Proposed`.
- **`Accepted` means no unresolved contradiction remains in the text.** An ADR may be `Accepted` with open questions, but not with a known conflict against another accepted ADR.
- **Open questions are capped at what genuinely blocks a decision.** They are not a backlog. Anything that is really implementation work belongs in an issue tracker.
- **A contradiction between two ADRs is resolved by editing one of them**, not by documenting the conflict in both.
- Supersede rather than rewrite history: an ADR that no longer holds is marked `Superseded` with a pointer, and the replacement states what changed.

### Diagrams

Diagrams of the topology and of data flows live in [`diagrams/`](diagrams/README.md), one Markdown page per subject, drawn in **Mermaid** so they are text: diffed, reviewed and versioned with the ADRs, and rendered by GitHub without a build step. Image files and drawing-tool exports are not used, because nobody can review a change to them.

A diagram **decides nothing**. Each page names the ADRs it illustrates, and where it disagrees with an ADR or the code, the ADR and the code win and the diagram is corrected. A change that moves a port, a network membership or a flow a diagram shows updates that diagram in the same commit, as it updates the ADR. The topology page's network matrix and listener table are checked against `compose.yaml` and the scrape and datasource configuration by `scripts/diagrams.sh`, a static check of `scripts/ci.sh` ([0015](0015-testing-vitest-playwright.md)); the flow diagrams have no such check and are kept by review. This keeps the directory the only architecture source while still giving readers a picture. Decided 2026-10-02.

### Relationship to `docs/adr/`

This directory supersedes `docs/adr/`. The v1 directory is retained for history and should not be extended. Where a v2 ADR replaces v1 entries, its `Supersedes` field names them.

The standalone `docs/technical-architecture.md` has been removed rather than carried forward as a parallel source of truth; the root `README.md` points into these ADRs instead. Keeping both was what produced the duplicated, drifting decision text in the first place.

## Consequences

- Twenty-five ADRs instead of seventy, each mapping to a decision someone actually made.
- Some detail from v1 is deliberately not reproduced. What is not yet decided is listed in the README rather than implied by silence.
- Adding a service or library no longer implies adding an ADR.
