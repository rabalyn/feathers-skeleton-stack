# 0001: One containerized stack in every environment

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0003, 0034, 0037, 0053
- Related: [0002](0002-service-inventory-and-networks.md), [0016](0016-nginx-and-tls-everywhere.md), [0017](0017-nfs-backup-storage.md), [0023](0023-secrets-management.md), [0026](0026-mcp-development-tooling.md), [0027](0027-email-templates-and-sending.md)

## Context

The previous architecture ran three different topologies: a direct local development loop, a containerized test profile, and a production stack containing services (log shipping, NFS, TLS issuance) that existed nowhere else. Every production-only path was therefore first exercised in production.

This repository is a skeleton: the common infrastructure base that future products are built on. Whatever it gets wrong is inherited by every product, which makes environment parity worth more here than in a single application.

## Decision

One stack. Every service runs as a container in every environment, with the same image, the same routing, and the same TLS.

- Local and CI topology is defined in a **Compose file** (`compose.yaml`). Production is defined as **systemd Quadlet units** — `.container`, `.network` and `.volume` files under `deploy/quadlet/`, turned into systemd services by the Quadlet generator and managed with `systemctl --user`.
- **`compose.yaml` is the single source.** The Quadlet units are generated from it with `podlet` and committed. Production-only settings (restart policy, the NFS mount dependency, secret mounts) live in Quadlet drop-in files next to the generated units, never as edits to them. CI regenerates the units and fails if the result differs from what is committed.
- **The product's identity comes from `product.env`** ([0035](0035-products-derived-from-the-skeleton.md)): the project name, the display name and the two local ports. `compose.yaml` interpolates them and refuses to start without them, so the stack is driven through the scripts, which read the file. Locally every container is named `<project>-<service>` so that several products' stacks run side by side; services still reach each other by their service names, which podman-compose gives each container as a network alias. The generator writes the values into the units and drops the prefix, since in production each product runs as a user of its own and the units keep `ContainerName=api`. Decided 2026-10-05.
- Three services are containers locally but **external systems in production**, because their production counterparts belong to the university: the SAML2 identity provider, the LDAP directory, and the SMTP relay. The application speaks the same protocol to both and only the endpoint changes, by configuration. This is why they run as containers locally — it is how the production paths get exercised at all.
- **Products are self-contained.** Beyond this stack they depend only on the university's own systems above; no SaaS or other third-party hosted service is used for any concern — mail, monitoring, storage, search or anything else. A need that such a service would meet is met by a container in the stack or by a university system.
- The `api` and `web` containers may additionally run a watch command with the source bind-mounted, under a `dev` Compose profile. CI and production always run the built image. Nothing else about the topology changes between profiles.

### Where parity is deliberately not kept

Stated here so that nothing claims more parity than exists:

| Concern | Local | CI | Production | Why |
| --- | --- | --- | --- | --- |
| TLS certificates | One-shot local CA job | Same as local | ACME client against the institutional CA | ACME adds nothing on a machine nobody reaches from outside; what matters locally is a valid chain ([0016](0016-nginx-and-tls-everywhere.md)) |
| Backup target | Named volume | Real NFS mount on the runner | Real NFS export, mounted by the host | Rootless Podman can neither mount NFS nor run an NFS server; CI runners have root ([0017](0017-nfs-backup-storage.md)) |
| OpenBao unseal | Scripted | Scripted | Manual, by an administrator | Local and CI secrets are random throwaway values ([0023](0023-secrets-management.md)) |
| Uptime check | In the stack | In the stack | Must run on another machine | A check on the same host dies with it ([0022](0022-observability-and-alerting.md)) |
| Container log viewer | Dozzle | Dozzle, unused; the runner needs the rootless Podman API socket | None | A developer convenience that nothing depends on; production logs are read in Grafana ([0002](0002-service-inventory-and-networks.md), [0022](0022-observability-and-alerting.md)) |
| MCP servers for coding agents | In the stack | In the stack, checked by `stack.sh mcp` | None | Development tooling over seeded data only ([0026](0026-mcp-development-tooling.md)) |

## Consequences

- Nginx, TLS, SAML2, LDAP, secret delivery and the backup path are exercised from the first day of development rather than first attempted in production.
- A developer machine runs roughly forty containers, one of them the coding agents' browser ([0026](0026-mcp-development-tooling.md)). This is the deliberate cost of the parity rule.
- Adding a service means adding it to `compose.yaml` and regenerating; the CI check catches a forgotten regeneration.
- Generated units depend on `podlet` covering the Compose features used. A feature it cannot translate goes into a drop-in.
