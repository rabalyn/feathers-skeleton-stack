# CLAUDE.md

## Source of truth

- `docs/adr_v2/` is the authoritative architecture. Start with `docs/adr_v2/README.md`, then 0001.
- `docs/adr/` is superseded v1 history. Do not implement from it and do not extend it.
- There is no other architecture document. If code and an ADR disagree, raise it; do not silently follow either.

## Working rules

- When an ADR does not cover a decision, or covers it ambiguously, **ask before deciding**. Do not fill gaps with assumptions.
- A decision that changes an ADR is recorded in that ADR as part of the same change, following the convention in `docs/adr_v2/0019-adr-convention.md`.
- This repository is a skeleton for future products: keep product-specific logic out, and keep infrastructure generic.
- New Feathers services are created with `pnpm gen:service`, not by hand and not with `@feathersjs/cli` (`docs/adr_v2/0030-service-generator.md`).
- Frontend work uses the `quasar` MCP server: look up every Quasar component, plugin, directive, composable or app-vite option you use before writing or changing code with it. Before writing or changing an end-to-end test, open its pages through the `playwright` MCP server and read them with `browser_snapshot`. If a server isn't connected, say so instead of working from memory (`docs/adr_v2/0026-mcp-development-tooling.md`, *When an agent must use them*).

## Implementation approach

Build thin vertical slices that exercise the riskiest parts first (OpenBao secret delivery under rootless Podman, `podlet` Quadlet generation, SAML2 via Keycloak, per-worker test databases through PgBouncer) before widening to backups, the worker, observability and uploads.
