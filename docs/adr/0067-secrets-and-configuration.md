# 0067: Host-managed secrets and environment-based configuration; no secrets platform yet

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1); secrets platform Deferred
- Source: [Technical architecture › Configuration and Security, Production, Runtime Topology](../technical-architecture.md#configuration-and-security)
- Related: [0015](0015-database-roles-and-connection-paths.md), [0023](0023-hybrid-jwt-refresh-cookie.md), [0043](0043-minio-object-storage.md), [0051](0051-backup-container-isolation.md), [0070](0070-deployment-specific-configuration.md)

## Context

The stack needs many credentials across a single host, and must not commit any of them.

## Decision

- Commit example configuration only (such as `.env.example`); never commit credentials.
- Local development: generate random S3 and database credentials into an ignored `.env.local` file with mode `0600`, or create them as rootless Podman secrets. `.env.local` is a single-developer convenience, not a shared secret store.
- One-host production: keep credentials in rootless Podman secrets or protected systemd/Quadlet environment files owned by the deployment user. Limit file permissions and rotate credentials deliberately.
- Provide separate credentials for the API, backup jobs, monitoring, and local S3 administration.
- Don't add a dedicated secrets platform yet. Introduce one when multiple hosts, multiple operators, automated rotation, or compliance requirements make host-managed secrets insufficient.
- Pass configuration through environment variables or a secret mechanism. Validate required environment variables at application startup.

## Consequences

- No extra infrastructure for secrets.
- Rotation and recovery of secrets are manual.

## ToDos

- ToDo: [Contradiction] The Production section says "environment variables or a **secret store**", while this decision says not to add a dedicated secrets platform. Clarify that "secret store" means Podman secrets or protected environment files.
- ToDo: [Clarify] "Local S3 administration" appears in the **production** credential list. Is there a production S3 root/admin credential, who holds it, and how is it separated from the API and backup keys?
- ToDo: [Missing] A full secret inventory: database roles (API, migration/admin, backup, monitoring), PgBouncer auth file, Valkey password/ACL (not mentioned anywhere), JWT signing secret, S3 keys per service, restic password, email provider credentials, Grafana admin, Dozzle authentication.
- ToDo: [Clarify] Podman secrets exposed as environment variables are visible through `podman inspect`; mounting them as files avoids this. Pick a convention.
- ToDo: [Clarify] Feathers configuration layering (`node-config` files plus `custom-environment-variables`) and how startup validation is implemented (for example a TypeBox schema for configuration).
- ToDo: [Missing] Rotation procedures and cadence. "Rotate deliberately" isn't a procedure, and rotating the JWT secret logs out every user.
- ToDo: [Missing] Backup of secrets for disaster recovery (ADR 0047).
