# 0026: Require real email delivery for password reset and verification before production

- Status: Proposed
- Date: 2026-09-14
- Scope: Development tokens during scaffolding; real delivery Required before first production release
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0022](0022-local-password-authentication.md), [0024](0024-refresh-session-storage.md), [0025](0025-authentication-rate-limiting.md), [0035](0035-private-podman-networks.md), [0067](0067-secrets-and-configuration.md)

## Context

Password reset and email verification need an out-of-band channel. The scaffold should not be blocked on choosing an email provider.

## Decision

During scaffolding, password reset and email verification may use development-only tokens. A production release requires a real email delivery integration with **expiring, single-use** tokens.

## Consequences

- Early development can proceed without email infrastructure.
- Production readiness depends on an email integration, its credentials, and outbound network access.

## ToDos

- ToDo: [Missing] Email delivery mechanism and provider (SMTP relay, transactional email API) aren't chosen.
- ToDo: [Missing] The network model (ADR 0035) has no outbound internet path for the API to reach an email provider.
- ToDo: [Clarify] Token storage (hashed in PostgreSQL?) and lifetimes for reset and verification tokens.
- ToDo: [Clarify] Whether email verification is required to log in, only for some actions, or at all if registration isn't self-service (ADR 0022).
- ToDo: [Missing] A guard that prevents the development-only token mechanism from being enabled in production (for example startup configuration validation).
- ToDo: [Clarify] Library choice (for example `feathers-authentication-management`) or custom implementation.
- ToDo: [Clarify] Whether a completed password reset revokes all sessions like a password change (ADR 0024).
- ToDo: [Missing] An email-change flow that re-verifies the new address.
- ToDo: [Missing] A local/CI mail-capture service (for example Mailpit) so reset flows can be tested end-to-end. None is in the Compose inventory (ADR 0037).
