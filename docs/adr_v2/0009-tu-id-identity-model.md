# 0009: TU-ID is the user-facing identifier; a surrogate key is the internal one

- Status: Accepted
- Date: 2026-09-23
- Scope: Required (v1)
- Supersedes: v1 ADRs 0019, 0020
- Related: [0008](0008-authentication-saml2-ldap.md), [0011](0011-casl-role-authorization.md), [0013](0013-gdpr-export-and-retention.md), [0020](0020-object-storage-uploads.md)

## Context

The TU-ID is the university's global identifier for a person. It is what users recognise, what they expect to log in as, and what staff use to refer to an account. It is also directly identifying personal data.

## Decision

- Every user record carries `tu_id`: unique, not null for university accounts, indexed, and never reassigned. It is taken from the `cn` attribute ([0008](0008-authentication-saml2-ldap.md)).
- **TU-ID is the identifier shown to users everywhere** — the login name presented at sign-in, the identifier in the UI, in administrative screens, and in API payloads that describe a user.
- The database primary key is a **surrogate** (`id`), not the TU-ID. Foreign keys reference the surrogate. Two reasons: relational integrity should not depend on an externally owned value, and erasure ([0013](0013-gdpr-export-and-retention.md)) needs a way to clear direct identifiers while leaving referentially sound rows behind.
- The break-glass superadmin has no TU-ID; `tu_id` is nullable and that account is distinguished by its authentication source, not by a sentinel value.
- **Internal logs, metrics and traces reference the surrogate `id`, never the TU-ID.** This is a deliberate narrowing of "TU-ID everywhere": log retention then does not accumulate direct identifiers, which keeps [0013](0013-gdpr-export-and-retention.md) tractable. Audit events that genuinely need to name a person for accountability may store the TU-ID and are retained under the audit retention rule rather than the log rule.
- Directory attributes mapped on each login: TU-ID (`cn`), name, surname, email. The local record is refreshed from the assertion on every login, so the directory remains authoritative for these fields. They are readable by the user and not editable in the application.

## The skeleton domain model

This repository is the common base for future products, so it carries only what every product needs, plus enough to exercise the infrastructure end to end:

| Entity | Contents | Purpose |
| --- | --- | --- |
| User | Surrogate id, TU-ID, name, surname, email, role, enabled flag, optional avatar | Every product has users; this is also the minimal GDPR export ([0013](0013-gdpr-export-and-retention.md)) |
| Avatar | An image upload attached to the user record; the only field a user edits on their own record | Exercises image upload and inline image serving ([0020](0020-object-storage-uploads.md)) |
| Document | Owner, title, an uploaded file and its metadata (original filename, size, content type, checksum), timestamps | Exercises file upload, ownership scoping, real-time channels and the export |

Product-specific data and access rules are out of scope here and are added by each product.

## Consequences

- Users see the identifier they expect; the schema does not depend on it.
- There are two identifiers for a person in the system, and every developer needs to know which one belongs in which context. The rule is: TU-ID at the boundary, surrogate internally.
- Directory-sourced fields are overwritten on each login, so local edits to them would be lost. They are therefore not editable in the application.
