---
name: fix-merge-conflicts
description: Resolve merge conflicts with BUILD-VALIDATED output — only declare resolved after the project builds AND tests pass against the merged tree. Triggers on "fix conflicts", "merge conflict", "rebase conflict", "resolve conflicts", or after a failed `git merge` / `git rebase` / `git pull`.
userInvocable: true
allowedTools: ["Bash", "Read", "Grep", "Edit"]
category: skill
stability: stable
---

# Build-validated merge-conflict resolution

Adapted from Cursor CTK `fix-merge-conflicts` (ADR-0102 absorption batch).
The job is to resolve conflicts AND prove the merged tree compiles + tests
pass — not to make `<<<<<<<` markers disappear.

## When this skill activates

- The user says "fix conflicts" / "resolve conflicts" / "merge conflict".
- A `git merge` / `git rebase` / `git pull` returned conflicts.
- A PR shows `mergeable: CONFLICTING`.

## P0 rules

1. **Conflicts have CONTEXT.** Every conflict resolution must cite WHY the
   chosen side is correct — read the change's commit messages on BOTH sides,
   not just the diff hunks.
2. **No "ours" / "theirs" without justification.** `git checkout --ours` or
   `--theirs` as a default is a bug. Resolution must be a deliberate merge
   decision, not a side-selection.
3. **Build-validated is mandatory.** Resolved ⇒ `bun run typecheck && bun
   test` (or the repo's equivalent) MUST pass against the merged tree.
   Compile-clean is not enough; tests must run.
4. **Never `git rerere`-by-memory.** Each conflict in this turn is read
   fresh; do not reuse a resolution from a prior session without re-reading
   both sides.
5. **Never abort silently.** If a conflict resolution is non-obvious (both
   sides made semantically incompatible changes), STOP and ask the user.

## Procedure

1. **Survey the conflict set.** `git status --porcelain | grep '^UU'` to
   enumerate. For each file: `git log --oneline <fromSha>..HEAD -- <file>`
   on both branches to see WHO changed it and why.
2. **For each conflicted file, read the FULL file (not just the markers).**
   Conflict markers hide the surrounding semantic context. The resolution
   often requires touching code 50+ lines away from the marker.
3. **Resolve ONE FILE AT A TIME.** Stage with `git add <file>` after each
   resolution so a typecheck mid-stream tells you which file broke compile.
4. **Run the full build after EACH resolution.** Catching a broken
   resolution at file N is cheaper than fixing N conflicts at once.
5. **Run the test suite before declaring resolved.** Conflicts that compile
   but break runtime semantics are common (signature merged, but caller
   logic from one side now mismatches).
6. **Report what you decided, not just what you did.** For each conflict,
   one sentence: "kept SIDE because REASON; combined SIDE+SIDE for FIELD
   because REASON".

## Outcome enum

- `resolved` — every `UU` cleared, typecheck green, tests green, decisions
  documented.
- `partial` — some conflicts resolved but the merged tree does not compile
  or test; loop must continue.
- `blocked` — a conflict has semantically incompatible changes that require
  user input; STOPPED + asked.

The string `complete` is forbidden until the merged tree is `resolved`.
