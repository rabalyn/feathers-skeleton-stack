# 0022: Use Feathers local email/password authentication

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0023](0023-hybrid-jwt-refresh-cookie.md), [0024](0024-refresh-session-storage.md), [0025](0025-authentication-rate-limiting.md), [0026](0026-password-reset-and-email-verification.md)

## Context

Users need to sign in. No external identity provider is part of the architecture.

## Decision

Use Feathers local authentication with email and password (`@feathersjs/authentication-local`). Password hashes are created and stored by the local strategy and are never returned by services.

## Consequences

- The application owns credential storage, password reset, and brute-force protection (ADR 0025, 0026).
- Result resolvers or external hooks must strip password hashes on every transport, including real-time events.

## ToDos

- ToDo: [Missing] Registration model: open self-registration, admin invitation, or bootstrap-only accounts.
- ToDo: [Clarify] Hash algorithm and cost. `@feathersjs/authentication-local` uses bcrypt by default: keep it with a tuned cost factor (note bcrypt's 72-byte input limit), or plug in argon2?
- ToDo: [Missing] Password policy: minimum length, and whether breached-password checks apply.
- ToDo: [Clarify] Email normalization and uniqueness (case-insensitive unique index or `citext`).
- ToDo: [Clarify] Whether email verification is required before login (ADR 0026).
- ToDo: [Missing] A "disabled" account state is assumed by "revoke all sessions when … an account is disabled" (ADR 0024) but isn't modelled.
- ToDo: [Clarify] Whether a password change requires the current password or recent re-authentication.
- ToDo: [Clarify] Whether multi-factor authentication is explicitly out of scope for v1.
