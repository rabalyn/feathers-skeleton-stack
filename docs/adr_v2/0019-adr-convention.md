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

The application shows the same files on an **architecture page** (`/docs`): a tab per diagram page, in the order of the diagrams index and under its names, with the Mermaid drawn in the browser, and the ADRs with a search over their text. The files are not copied or converted: the api image carries `docs/adr_v2/` and a read-only `docs` service serves it, under the `docs.read` permission, which only `admin` holds as seeded ([0011](0011-casl-role-authorization.md)), because the pages describe the stack's services, ports and networks. They are never bundled into the public web app, where anyone could fetch them. Links between pages stay in the app; a link to another file of the repository loses its target there. The page decides nothing either, and a change to these files reaches it with the next api image. Decided 2026-10-05.

A product's own ADRs in `docs/adr_product/` ([0035](0035-products-derived-from-the-skeleton.md)) are on the same page, read the same way and served by the same service: the image carries both directories. Their diagram pages, in `docs/adr_product/diagrams/` beside an index of their own, are tabs after the skeleton's, the index as the product overview; their ADRs, with that directory's README as their index, have a tab of their own after the skeleton's ADRs, shown once the product has one, and the search on each ADR tab finds that tab's pages. The product's pages carry ids prefixed `product-`, so the two sets, both numbered from 0001, never collide and the skeleton's pages keep their addresses. Links between the two directories stay in the app. The skeleton's directory is required; the product's is read where it exists, its diagrams where they have an index. Decided 2026-10-06.

### Relationship to `docs/adr/`

This directory supersedes `docs/adr/`. The v1 directory is retained for history and should not be extended. Where a v2 ADR replaces v1 entries, its `Supersedes` field names them.

The standalone `docs/technical-architecture.md` has been removed rather than carried forward as a parallel source of truth; the root `README.md` points into these ADRs instead. Keeping both was what produced the duplicated, drifting decision text in the first place.

## Consequences

- Twenty-five ADRs instead of seventy, each mapping to a decision someone actually made.
- Some detail from v1 is deliberately not reproduced. What is not yet decided is listed in the README rather than implied by silence.
- Adding a service or library no longer implies adding an ADR.
