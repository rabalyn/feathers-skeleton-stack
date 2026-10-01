# 0033: Feature branches are deleted once merged, on GitHub and locally

- Status: Accepted
- Date: 2026-10-01
- Scope: Required (v1)
- Related: [0015](0015-testing-vitest-playwright.md), [0018](0018-owasp-security-baseline.md), [0019](0019-adr-convention.md)

## Context

Every change reaches `main` through a feature branch and a pull request. Merged branches were kept, on GitHub and in the local clone, and by 2026-10-01 nine of them had piled up, all fully merged. A kept branch tells nobody anything that `main`'s history doesn't, and it makes the branch list useless for seeing what is still in progress.

Local cleanup also has a trap: git won't delete a branch that a checkout has checked out. A branch left checked out after its pull request is merged blocks its own deletion. In a worktree, `main` usually can't be checked out either, because the main checkout already holds it.

## Decision

- **A feature branch is deleted as soon as its pull request is merged, on GitHub and locally.**
  - On GitHub, the repository setting "Automatically delete head branches" does it on every merge. It is on since 2026-10-01. A branch that it misses (one merged outside a pull request) is deleted with `git push origin --delete <branch>`.
  - Locally, the branch is deleted with `git branch -d <branch>`, after `git fetch --prune origin` has removed its remote-tracking ref. `-d` refuses a branch that isn't merged, which is the check wanted here; `-D` is not used for cleanup.
- **When a feature is done, its checkout returns to `main`**, so the local deletion isn't blocked by the branch still being checked out. In the main checkout that is `git switch main && git pull --ff-only`. In a worktree, where `main` is held by the main checkout, it is `git switch --detach origin/main` after a fetch. The worktree is then either removed or starts its next feature branch from there.
- A branch with an open pull request, or with commits that aren't on `main`, is never deleted by this cleanup.

## Consequences

- The branch list on GitHub and locally shows only work in progress.
- A deleted branch can still be restored from its pull request page on GitHub for as long as GitHub keeps it, and its commits remain reachable from `main` through the merge.
- A pull request opened on top of another feature branch is retargeted to `main` by GitHub when its base is merged and deleted automatically. A base branch deleted by hand instead closes the pull requests on top of it, so stacked pull requests are retargeted before such a deletion.
- Remote deletion needs nobody to remember it; local deletion does, and stays a step of finishing a feature.
