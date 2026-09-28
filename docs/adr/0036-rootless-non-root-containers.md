# 0036: Use rootless Podman everywhere and run images as non-root users

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Goals, Rootless Podman](../technical-architecture.md#rootless-podman)
- Related: [0005](0005-production-log-path.md), [0034](0034-single-host-rootless-quadlet.md), [0037](0037-compose-and-quadlet-definitions.md), [0050](0050-nfs-backup-mount.md), [0056](0056-github-actions-ci.md)

## Context

Local development and deployment should be reproducible and shouldn't need root on the host.

## Decision

Rootless Podman is the target container runtime for local development, CI, and deployment where supported. Images run as a non-root user internally whenever the base image and service allow it. Bind-mounted files and volumes must be checked for UID/GID compatibility in rootless environments.

## Consequences

- A container escape lands in an unprivileged user namespace.
- UID/GID mapping has to be handled deliberately for bind mounts, volumes, and NFS.

## ToDos

- ToDo: [Clarify] "Where supported": which environments aren't? For example developers on macOS/Windows (Podman machine) or GitHub-hosted runners. Define the fallback or require Linux.
- ToDo: [Missing] A numeric UID/GID convention per image, and when `--userns=keep-id` is used for development bind mounts.
- ToDo: [Verify] Under rootless Podman, a container UID that isn't mapped to the deployment user shows up on the host, and therefore on the NFS server, as a subordinate UID (for example 100000+N). The "dedicated numeric UID/GID authorized by the NFS export, rather than the deployment user's identity" (ADR 0050) must therefore be the mapped host ID. Verify against the export's squash and ID-mapping settings.
- ToDo: [Clarify] Whether images that start as root and drop privileges (for example the official PostgreSQL image entrypoint) are acceptable.
- ToDo: [Clarify] Exposing the rootless Podman socket to Dozzle grants full control over all of the deployment user's containers (ADR 0005).
