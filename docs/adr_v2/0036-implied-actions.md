# 0036: Every action implies reading, deleting implies changing, built into the catalogue

- Status: Accepted
- Date: 2026-10-09
- Scope: Required (v1)
- Related: [0011](0011-casl-role-authorization.md), [0012](0012-role-scoped-channels.md), [0029](0029-api-tokens.md), [0037](0037-permission-prerequisites.md), [0038](0038-gates-cover-what-a-page-calls.md)

## Context

feathers-casl checks the result of a create, a patch or a remove against `read`. So every catalogue entry that writes also grants `read` on its subject, written by hand beside the write, mostly with the comment "`read` for feathers-casl's check of the create's result". That read is unconditional unless the entry says otherwise, and it opens the whole list, not the record written: in the first product (foocore-key, its product ADR 0013 and the permission map of 2026-10-09) changing a borrower's comment reads every borrower, and adding keys opens the key list. Nothing in the catalogue says so; it is found by reading each entry.

The user proposed on 2026-10-09 that the implication be built in instead: an action implies the weaker ones. Of the linear order *read ⊂ create ⊂ update ⊂ delete* the step from update to create was left out, because it would let a permission that fixes a record also add new ones (a key's expiry, someone else's API tokens).

## Decision

Decided with the user on 2026-10-09.

- **The order of actions**: `create` implies `read`; `patch` implies `read`; `delete` implies `patch`, and so `read`. `patch` does not imply `create`. The alias `write` (`create` and `patch`) implies `read` accordingly.
- **The ability module applies it**, not each entry: `defineAbilitiesFor` hands every entry's `grant` a `can` that, for each rule it receives, also adds the implied rules on the same subject **with the same conditions and the same field list**. A write under `documents.own`, limited to the caller's documents, implies reading those documents only.
- **An entry's own rule wins.** No implied rule is added for an action and subject the same entry grants itself; that is how an entry states a narrower read than its write would imply (`sessions.revoke` reads sessions without the user agent).
- **Entries no longer write the result-check read.** The lines that exist only for feathers-casl's check are removed; a read the entry means on purpose stays, with its comment saying what it is for.
- **Unconditional creates that must not read everything get an explicit read.** As of this decision: `files.upload` reads one's own files (`{ ownerId }`), `api-tokens.create` one's own tokens (`{ userId }`), `data-exports.any` the exports one requested (`{ requestedBy }`). A unit test lists every entry whose implied read is unconditional, so a new one is a reviewed choice.
- **The browser builds the same ability** from the same module ([0011](0011-casl-role-authorization.md)), so what the UI hides and what the server refuses stay one rule. API tokens ([0029](0029-api-tokens.md)) get their abilities from the same function.
- **The permissions page shows the implication** as part of each permission's description: a permission that writes reads what it writes.

## Consequences

- "Who can change it can see it" is a property of the catalogue instead of a side effect of each entry, and reading the catalogue tells what a permission opens.
- It does not narrow anything: writing a subject still reads all of it unless the entry's conditions say otherwise. A product that wants writers without the list must give the write conditions, or state the narrower read in the entry.
- `users.enable` now reads every user record, as `users.read` does; the Users page needed that already.
- A rule with conditions on a create (a state-machine step that names `from` and `to`) implies a read with the same conditions, which a result without those fields fails. Such an entry states its read itself, as before.
- Every catalogue entry is touched once, in the skeleton and in each product; the change ships with a skeleton tag and its products adjust their entries when they merge it.
