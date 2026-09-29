# 0028: Read-only view-as another user, bounded by the viewer's own rights

- Status: Accepted
- Date: 2026-09-29
- Scope: Required (v1)
- Related: [0010](0010-sessions-postgres-ratelimits-valkey.md), [0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0013](0013-gdpr-export-and-retention.md), [0021](0021-structured-logging.md), [0025](0025-runtime-settings.md)

## Context

With roles editable ([0011](0011-casl-role-authorization.md)), an admin or operator supporting someone needs to see what that person sees. A role preview answers "what does this role see" but not "why does this person not find their document". Letting staff act as someone else answers it, at a cost: every write would need an attributable actor, and acting in a person's name needs a legal basis that seeing their screen does not.

The alternatives were full act-as (write as the target), role preview only, and deferring the decision. Read-only view-as with the role preview was chosen: it covers support and role tuning without writes made in anybody's name.

## Decision

- **View-as** is the catalogue permission `users.view-as`, seeded for nobody but `admin`. It shows the application as a chosen user sees it, **read-only**.
- It is state of the viewer's own session, not a session of the target's: `auth_sessions` gains `view_as_user_id` and `view_as_expires_at`. No token is issued in the target's name, and the viewer's tokens stay the viewer's. The `view-as` service starts it (`create` with the target's surrogate id) and ends it (`remove`); logout, revocation of the session and expiry end it too. Its lifetime is a runtime setting, default **30 minutes** ([0025](0025-runtime-settings.md)), and it is not extended.
- While a session is in view-as, each request runs as the target with an **intersected ability**, rebuilt per request like any other ([0010](0010-sessions-postgres-ratelimits-valkey.md)):
  - only the target's `read` rules are kept; every write, create and delete is dropped;
  - of those, a rule is kept only for a subject **the viewer may read without conditions**, and its fields are narrowed to the viewer's fields for that subject. A viewer with `documents.all` sees the target's documents as the target does; a viewer without `audit-events.read` does not see the target's activity, although the target does.
  - So view-as can never show the viewer anything their own rights would not. It needs no subset check between the two people's roles, and a later change to either's roles applies on the next request.
  - What only the owner ever sees drops out by the same rule: nobody reads `data-exports` without conditions ([0013](0013-gdpr-export-and-retention.md)), so the target's exports stay hidden.
- Refused, with **403** and nothing started: viewing as oneself, as a holder of `admin`, as the break-glass account, as an erased account, and starting view-as from a session already in view-as. Ending view-as is the one write allowed while it lasts, and it is checked against the viewer's own ability.
- Starting and ending view-as ends the session's connections, which rejoin their channels under the intersected ability or, afterwards, under the viewer's own ([0012](0012-role-scoped-channels.md)).
- Audit ([0013](0013-gdpr-export-and-retention.md)): `view-as.start` and `view-as.end` (with the reason: stopped, expired, logout, revoked), the viewer as actor and the target's account as resource. Individual reads are not audited, as they are not outside view-as; the viewer's log lines carry the target's surrogate id as `viewAsRef` beside `userRef` ([0021](0021-structured-logging.md)). The target finds these events in their own export, as the events about their account.
- The UI shows a banner for as long as view-as lasts, naming the target by TU-ID, with the remaining time and a button to end it. The browser builds the intersected ability with the same function from the ability module as the server, from both people's permission keys ([0007](0007-typed-client-from-api.md)); a note in the banner says that parts the viewer may not read are hidden.
- The role preview on the permissions page ([0011](0011-casl-role-authorization.md)) is not view-as: it changes only what the admin's own screen offers, reads nothing as anybody, and needs neither this permission nor audit.

## Consequences

- Staff see a person's screen without a password, a shared account or a screenshot, and without the ability to change anything in that person's name.
- The viewer may see less than the target does. That is the price of never seeing more than one's own rights allow, and the banner says so.
- One more state on the session row, checked on every request. The query is the one the session check already makes.
- Looking at a named person's data through their eyes is processing of personal data. The data protection officer should confirm the purpose and the notice before production, alongside the record of processing activities ([0013](0013-gdpr-export-and-retention.md)); where staff are the viewed users, the staff council may need to agree.

## Open questions

- Whether the target should be told at the time, by a notification mail ([0027](0027-email-templates-and-sending.md)) or on their next login, rather than only through their export. Depends on the data protection officer's view.
