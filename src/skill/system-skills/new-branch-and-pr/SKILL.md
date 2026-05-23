---
name: new-branch-and-pr
description: End-to-end ship for a NEW change — create a branch, stage the diff, commit with a clear message, push, open a PR. Triggers on "create a PR", "ship this", "open a pull request", "make a new branch and PR".
userInvocable: true
allowedTools:
  - Bash
  - Read
  - Edit
category: skill
stability: stable
tools:
  - Bash
  - Read
  - Edit
---

# Branch + commit + push + PR (end-to-end ship)

Adapted from Cursor CTK `new-branch-and-pr` (ADR-0102 absorption batch).
The job is to take "I have changes that should ship" and emit a PR URL,
without bypassing the Git posture rules.

## When this skill activates

- The user says "create a PR" / "ship this" / "open a pull request".
- A change is complete + verified, and the user wants it on a branch.

## P0 rules

1. **Explicit user consent is required.** This skill PERFORMS the
   mutations the Git posture (system prompt) bans by default — branch
   creation, commit, push, PR open. Activation is the consent; do not
   self-trigger on a vague phrase.
2. **Branch naming follows convention.** Default to `quanta/<short-desc>`
   (kebab-case, ≤40 chars). Honor any `AGENTS.md` / `CLAUDE.md` repo
   convention that overrides — `feature/` / `fix/` / `release/` prefixes
   are common.
3. **Commit message is terse imperative.** First line ≤72 chars; body
   only if there's WHY context that isn't obvious from the diff.
4. **PR title is prefixed.** Default `[quanta] <short-desc>`. Same repo
   convention override applies.
5. **Never `--no-verify`.** Pre-commit hook failures are real; fix them.
6. **Stop after push if the PR cannot be auto-opened.** If the remote has
   no `gh` auth or the repo is not on GitHub, push to the branch and
   stop — do not invent an alternative PR system.

## Procedure

1. **Confirm the diff matches user intent.** `git status` + `git diff` —
   read both. If the working tree has unrelated edits, ask the user
   before staging them.
2. **Pick a branch name.** Derive from the user's task description.
   Cross-check against `git branch --list quanta/*` for collisions.
3. **Create the branch.** Use `git_branch_switch` tool with
   `create: true`, `autoWip: false` (this skill handles the staging).
4. **Stage + commit.** Use `git_commit` tool with `mode: "regular"`,
   `message: "<imperative>: <subject>"`. Always-confirm tier means the
   user sees the message before it commits.
5. **Push.** `git push -u origin <branch>` — set upstream so future
   pushes need no flag. The bash tool's always-confirm gate covers push.
6. **Open the PR.** `gh pr create --title "[quanta] <subject>" --body
   "<body>" --base main` (or whatever the repo's default branch is).
   Body MUST cite what changed and how it was verified.
7. **Report the PR URL.** That's the deliverable — the URL, plus a
   one-sentence summary.

## Outcome enum

- `pr-opened` — PR URL emitted; success.
- `pushed-no-pr` — branch pushed but PR could not be opened (no `gh`,
  no GitHub remote, auth issue); the branch URL is the deliverable.
- `stopped` — user declined a confirm prompt, or pre-commit hook failed
  and could not be auto-fixed; STOPPED + reported state.
