# 0006: Keep NFS backups separate from application object storage

- Status: Proposed
- Date: 2026-09-14

## Context

The architecture states that S3-compatible object storage is for application objects and that backup archives are stored on an NFS-backed path. It also allows local/CI object-storage integration tests, and it mentions a production object-export staging flow.

This creates a boundary question: is NFS backup storage the only persistent backup destination, or is the production S3 service also intended to stage or store protected backup artifacts in some cases?

ToDo: clarify whether S3 is ever a production backup repository or only an application object store, and whether backup staging is strictly NFS-only in production.

## Decision

Production database backups and restic repositories belong on the dedicated NFS mount, while S3-compatible object storage remains reserved for application file data and generated app artifacts. The backup staging flow is not treated as a production S3 repository.

This keeps the backup story explicit and prevents application storage from being conflated with recovery infrastructure.

## Consequences

- Backup operations remain isolated from application object data and object-storage service concerns.
- The architecture has a clearer disaster-recovery boundary: NFS is the recovery substrate; S3 is application data storage.
- Recovery procedures are easier to reason about because the destination and method are not mixed.
- The project must treat the NFS mount as a critical backup dependency and fail loudly when it is unavailable.

ToDo: add the exact backup retention chronology, including how the database dump, object export, and restic snapshot are coordinated in the release process.

## ToDos (review 2026-09-14)

- ToDo: [Clarify] The first ToDo above is answered by the architecture: "A backup-staging bucket exists only in local/CI profiles; production exports objects directly to the dated NFS staging tree." Confirm and close.
- ToDo: [Contradiction] The object staging tree on NFS holds **unencrypted** object bytes before the restic snapshot, while backups are described as encrypted (ADR 0049, 0050).
- ToDo: [Contradiction] Local/CI backup tests stage in an S3 bucket, while production stages on NFS, so the production backup path is never tested before production (ADR 0046, 0052).
- ToDo: [Contradiction] Making the NFS mount a startup prerequisite for the whole stack (ADR 0050) goes beyond "a critical backup dependency": an NFS outage would stop the application, not just backups.
