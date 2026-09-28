# 0044: Mediate all browser object access through the API; defer presigned URLs

- Status: Proposed
- Date: 2026-09-14
- Scope: Conditional (see ADR 0002); presigned URLs Deferred
- Source: [Technical architecture › S3-compatible object storage](../technical-architecture.md#s3-compatible-object-storage)
- Related: [0008](0008-feathersjs-v5-api.md), [0021](0021-casl-role-authorization.md), [0032](0032-external-nginx-ingress.md), [0043](0043-minio-object-storage.md), [0045](0045-upload-validation-limits.md)

## Context

Exposing S3 to browsers would need public routing and presigned-URL handling. Routing through the API keeps one authorization point.

## Decision

The browser accesses object data only through authorized Feathers API operations. The API validates ownership and permissions, then streams objects to or from S3. The S3 API and console are never exposed through public Nginx routes. Presigned URLs may come later if large-file bandwidth makes API-mediated transfers impractical.

## Consequences

- S3 stays fully private.
- All object bytes pass through the API, costing API bandwidth and connections.

## ToDos

- ToDo: [Clarify] Feathers services don't handle multipart uploads or streaming natively, so custom HTTP middleware (for example `busboy`) is needed outside the normal service/hook pipeline. Define how authentication, CASL checks, validation, and activity events apply there.
- ToDo: [Clarify] Uploads are REST-only (not over Socket.io), and `feathers-pinia` stores won't cover them. Define the frontend upload client.
- ToDo: [Missing] Object key scheme; object metadata in PostgreSQL (size, checksum, content type, owner); and orphan handling when the database insert fails after an upload, or vice versa.
- ToDo: [Clarify] Download behaviour: `Content-Disposition`, range requests, and cache headers.
- ToDo: [Clarify] Timeouts for 50 MiB transfers across external Nginx and the API (ADR 0032).
- ToDo: [Clarify] A measurable trigger for introducing presigned URLs.
