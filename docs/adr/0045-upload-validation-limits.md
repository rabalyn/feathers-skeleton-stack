# 0045: Limit uploads to 50 MiB and an explicit type allowlist, streamed without buffering

- Status: Proposed
- Date: 2026-09-14
- Scope: Conditional (see ADR 0002)
- Source: [Technical architecture › S3-compatible object storage](../technical-architecture.md#s3-compatible-object-storage)
- Related: [0031](0031-frontend-security-baseline.md), [0032](0032-external-nginx-ingress.md), [0044](0044-api-mediated-object-access.md)

## Context

Unrestricted uploads risk memory exhaustion, storage abuse, and hosting of dangerous content.

## Decision

- Maximum upload size is **50 MiB per object**.
- Accept only an explicit allowlist of MIME types and extensions. Validate the detected content type where practical.
- Stream transfers without buffering entire objects in API memory.
- Reject unknown or oversized objects.

## Consequences

- API memory use stays bounded regardless of upload size.
- New file types need an explicit allowlist change.

## ToDos

- ToDo: [Missing] The actual allowlist of types and extensions.
- ToDo: [Clarify] "Where practical": which detection library (magic-byte sniffing), and how text-based formats that can't be detected reliably (CSV, plain text) are handled.
- ToDo: [Clarify] Whether malware scanning, image re-encoding, or metadata stripping (EXIF) are in or out of scope.
- ToDo: [Missing] Per-user quotas or a total storage limit. There are none, and S3 volume sizing is undefined.
- ToDo: [Clarify] Size limits for generated exports.
- ToDo: [Missing] Serving rules that prevent stored XSS from uploaded HTML/SVG (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`) and filename sanitization.
- ToDo: [Clarify] External Nginx body size and buffering must match the 50 MiB limit (ADR 0032).
