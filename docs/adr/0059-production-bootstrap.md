# 0059: Create production initial data only through a manual, one-time bootstrap command

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (production)
- Source: [Technical architecture › Production](../technical-architecture.md#production)
- Related: [0015](0015-database-roles-and-connection-paths.md), [0021](0021-casl-role-authorization.md), [0026](0026-password-reset-and-email-verification.md), [0039](0039-release-procedure-and-rollback.md)

## Context

Default credentials or demo users created automatically at startup are a common security hole.

## Decision

Create production initial data with a manual, authenticated, one-time bootstrap command run after migrations. Never auto-create demo users, default passwords, or administrator credentials during API startup. Validate the bootstrap workflow before opening the app to real users, and create a single initial admin account explicitly for the first deployment.

## Consequences

- A fresh production instance has no usable account until an operator runs the command.
- The command must be safe to run exactly once.

## ToDos

- ToDo: [Clarify] "Authenticated": no users exist yet, so this presumably means operator access to the host (SSH as the deployment user) plus database credentials. Define it.
- ToDo: [Contradiction] The command creates an "admin" account, but the role model's top role is "owner" (ADR 0021).
- ToDo: [Clarify] How the initial password is set: interactive prompt, a generated one-time password, or a reset email (which needs ADR 0026 finished first).
- ToDo: [Clarify] How "one-time" is enforced (for example refuse to run if any owner/admin exists).
- ToDo: [Clarify] Where it runs (exec into the API container or a one-shot container) and which database connection and role it uses.
- ToDo: [Missing] "Validate the bootstrap workflow before opening the app to real users" needs a place to rehearse it; no staging environment is defined (ADR 0039).
