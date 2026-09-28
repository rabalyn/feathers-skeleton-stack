# 0025: Valkey-backed, fail-closed rate limits for login and password reset

- Status: Proposed
- Date: 2026-09-14
- Scope: Required (v1)
- Source: [Technical architecture › Backend](../technical-architecture.md#backend)
- Related: [0001](0001-production-valkey.md), [0022](0022-local-password-authentication.md), [0032](0032-external-nginx-ingress.md), [0060](0060-health-endpoints.md), [0061](0061-structured-logging.md)

## Context

Password login and password reset are brute-force and abuse targets. Rate-limit state must survive API restarts and be enforced consistently.

## Decision

- Store login and password-reset rate limits in Valkey, keyed by IP address and by account identifier.
- Defaults: **3 failed login attempts per 10 minutes** per account or IP; **3 password-reset requests per hour** per account or IP; a **15-minute cooldown**.
- Use generic authentication failure messages.
- Write structured security-event logs without passwords or tokens.
- If Valkey is unavailable, **reject** affected login and password-reset attempts (fail closed).

## Consequences

- Online brute force becomes impractical.
- A Valkey outage blocks new logins and resets, while existing sessions keep refreshing.
- Legitimate users who mistype can be locked out for 15 minutes.

## ToDos

- ToDo: [Contradiction] A per-account lock after 3 failures lets anyone lock a known user out indefinitely by sending 3 wrong passwords every 15 minutes, including the single owner/operator. This works against the availability goal. Consider progressive delays, keys per account+IP pair, or a different threshold.
- ToDo: [Clarify] 3 failures per IP per 10 minutes is very strict for users behind a shared NAT or corporate proxy.
- ToDo: [Clarify] How the 10-minute window and 15-minute cooldown interact: does the cooldown start at the third failure, does a successful login reset the counter, do further attempts extend the cooldown?
- ToDo: [Missing] Where the client IP comes from. The API sits behind external Nginx and rootless Podman port forwarding, so it must trust `X-Forwarded-For`/`X-Real-IP` only from the loopback proxy, and the infrastructure repository's Nginx must set those headers (ADR 0004, 0032). Otherwise every user shares one IP and the IP limit locks everyone out at once.
- ToDo: [Missing] Limits for `/authentication/refresh`, registration, and verification-email resend.
- ToDo: [Clarify] Should readiness (ADR 0060) and alerting (ADR 0065) cover Valkey, since its outage blocks logins?
- ToDo: [Clarify] Normalize account identifiers (case, whitespace) to prevent bypass. Bound Valkey keys created for non-existent accounts (TTL, memory limit).
- ToDo: [Contradiction] If Valkey evicts keys under memory pressure (ADR 0001), the limiter silently fails open, despite the fail-closed decision. Configure `maxmemory-policy noeviction` or equivalent.
- ToDo: [Clarify] Implementation library (for example `rate-limiter-flexible`) and Valkey client.
- ToDo: [Clarify] Security events live only in logs, retained 14 days (ADR 0064), and aren't audit events (ADR 0027). Is that enough for incident investigation?
