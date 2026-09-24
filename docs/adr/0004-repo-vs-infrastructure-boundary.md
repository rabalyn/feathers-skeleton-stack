# 0004: Keep the repo boundary separate from the external infrastructure repo

- Status: Proposed
- Date: 2026-09-14

## Context

The architecture states that production Nginx, certificates, DNS, and public routing are managed in a separate infrastructure repository, but also says this repository produces the application images and some production service configuration. This leaves a boundary question: which parts of the stack belong to this codebase and which belong to the external infrastructure layer?

This is a real ambiguity because the repository includes Podman/Quadlet definitions and operational instructions that imply deployment control, while the external platform is also said to own public routing and TLS.

ToDo: define the exact ownership split between application code, deployment artifacts, and infrastructure-as-code for public networking.

## Decision

This repository owns application code, application container images, local/CI/test topology, and the production host-side service definitions needed to run the app stack on one host. It does not own externally managed public networking, DNS, TLS issuance, or the public Nginx layer itself.

The application repository can define container, service ordering, environment-file contracts, and operational requirements, but the external infrastructure repository remains the source of truth for public routing and certificate management.

## Consequences

- The codebase stays focused on the app stack rather than on provider-managed public infrastructure.
- Deployment handoff is clearer because the ownership of public ingress and TLS is explicit.
- The project can still include Quadlet and service configuration without claiming responsibility for external network operations.
- Future changes in public routing or certificate flow must be coordinated across both repositories.

ToDo: add a one-paragraph repo ownership matrix that lists responsibilities by layer: app code, deployment config, infra repo, and public platform.

## ToDos (review 2026-09-14)

- ToDo: [Contradiction] The Runtime Topology section says "this repository produces the frontend image, the Feathers API image, and the S3-compatible object-storage service configuration **for the production platform to deploy**". That omits the PostgreSQL, PgBouncer, Valkey, backup, and observability units this repository also defines, and implies someone else deploys (ADR 0034).
- ToDo: [Missing] Host-level and cross-boundary items without an owner: host firewall (ADR 0033), NFS mount unit (ADR 0050), host Alloy installation and configuration (ADR 0064), deployment user with subuid/subgid and lingering (ADR 0034), CSP and security headers (ADR 0031), exclusion of `/health` and `/metrics` in external Nginx (ADR 0032), forwarded client-IP headers (ADR 0025), upload body-size limits (ADR 0045), certificate-expiry alerting (ADR 0065).
- ToDo: [Missing] A written interface contract between the two repositories (upstreams, paths, headers, timeouts), plus a way to keep the test-only Nginx configuration aligned with production Nginx (ADR 0054).
