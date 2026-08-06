---
description: "Version-control discipline for agent-built software: branches, atomic commits, PRs with evidence, and the operations that are never allowed. Use whenever committing, pushing, or opening/updating a pull request."
---

# Git Discipline

Git credentials are brokered — `git clone/pull/push` work against permitted
hosts without any token visible to you. GitHub operations (PRs, reviews,
issues) go through the GitHub tools when the agent has them.

## Rules

1. **Branch per task.** Never commit directly to `main`/`master` on a shared
   repo. Branch names: `agent/<short-task-slug>`.
2. **Atomic commits** with real messages: what changed and why, imperative
   mood, no "fix stuff". Commit at every green point in the dev loop — small
   commits are your undo history.
3. **PRs carry evidence.** A PR description states: what was built, how it was
   verified (typecheck/tests/screenshot viewports), and anything the reviewer
   must decide. If the work is visual, describe the verified screenshots.
4. **Respond to review comments on the PR**, commit the fixes to the same
   branch, and summarize what changed.

## Never

- `git push --force` on any shared branch.
- Rewriting published history.
- Committing secrets, `.env*` files, or credentials — check the diff before
  every commit.
- Merging your own PR when a human reviewer was requested — wait.

## When credentials fail

A failed push usually means the host isn't in the brokered allowlist. Say so
and stop — do not attempt workarounds; widening access is a human decision.
