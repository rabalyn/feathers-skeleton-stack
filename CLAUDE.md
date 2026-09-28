# CLAUDE.md

## Source of truth

- `docs/adr_v2/` is the authoritative architecture. Start with `docs/adr_v2/README.md`, then 0001.
- `docs/adr/` is superseded v1 history. Do not implement from it and do not extend it.
- There is no other architecture document. If code and an ADR disagree, raise it; do not silently follow either.

## Working rules

- When an ADR does not cover a decision, or covers it ambiguously, **ask before deciding**. Do not fill gaps with assumptions.
- A decision that changes an ADR is recorded in that ADR as part of the same change, following the convention in `docs/adr_v2/0019-adr-convention.md`.
- This repository is a skeleton for future products: keep product-specific logic out, and keep infrastructure generic.

## Implementation approach

Build thin vertical slices that exercise the riskiest parts first (OpenBao secret delivery under rootless Podman, `podlet` Quadlet generation, SAML2 via Keycloak, per-worker test databases through PgBouncer) before widening to backups, the worker, observability and uploads.
