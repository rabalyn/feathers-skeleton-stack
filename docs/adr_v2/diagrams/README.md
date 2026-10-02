# Diagrams

Pictures of what the ADRs decide, in [Mermaid](https://mermaid.js.org/) inside Markdown, so they are versioned and reviewed like the rest of the repository and render on GitHub and in most editors without a build step. The convention is in [0019](../0019-adr-convention.md#diagrams).

They decide nothing. Every page names the ADRs it illustrates; where a diagram and an ADR or the code disagree, the ADR and the code win and the diagram is fixed.

| Page | Shows | ADRs |
| --- | --- | --- |
| [Topology](topology.md) | Services by tier, who connects to whom on which port and network, every listener, the network membership matrix | 0002, 0016 |
| [Startup and secrets](startup-and-secrets.md) | Start order, OpenBao agents rendering secrets into tmpfs | 0023 |
| [Authentication](authentication.md) | SAML2 login, per-request session check, WebSocket channels, refresh rotation, API tokens, break-glass | 0008, 0010, 0011, 0012, 0029 |
| [Uploads](uploads.md) | Upload validation, download authorization, object lifecycle | 0020 |
| [GDPR](gdpr.md) | Data subject export through the worker, erasure | 0013 |
| [Mail and jobs](mail-and-jobs.md) | BullMQ queues, mail outbox, campaigns, update check | 0024, 0027, 0032 |
| [Backup](backup.md) | What a backup run reads and writes, restore post-steps | 0017 |
| [Observability](observability.md) | Scrape targets, log pipeline, alerting | 0021, 0022 |
| [NetBox](netbox.md) | Building lookup, NetBox SAML login, setup job | 0031 |
| [Testing](testing.md) | Per-file test databases, the e2e api, the coding agent's browser | 0015, 0026 |

## Editing

- Arrows point from client to server. Connection labels read `network · protocol :port`.
- Ports and network membership come from `compose.yaml`; a change there that moves a port or a network changes [Topology](topology.md) in the same commit. `scripts/diagrams.sh` (part of `scripts/ci.sh`) fails when its network matrix or listener table no longer matches. The other pages are kept by review.
- Preview with GitHub's Markdown preview, an editor's Mermaid extension, or [mermaid.live](https://mermaid.live/).
