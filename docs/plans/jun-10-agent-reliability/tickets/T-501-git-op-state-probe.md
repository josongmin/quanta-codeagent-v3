# T-501: detectGitOpState pure probe

**RFC:** [05·W1](../05-rfc-git-state-and-resume-staleness.md) · **Priority:** P1 · **Size:** S · **Deps:** none · **Posture:** library (consumers gate)

## Deliverable
Pure `detectGitOpState(repoRoot)` → `{op: "rebase"|"merge"|"cherry-pick"|"bisect"|"revert"|undefined, detail}` by stat-ing `.git` markers (`rebase-merge/`, `rebase-apply/`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `BISECT_LOG`, `REVERT_HEAD`). Worktree-aware (`.git` **file** indirection for linked worktrees). fs-stat only, no exec, no-throw (non-git → undefined). Direct precedent: Cursor's `checkMergeStatus`/`checkRebaseStatus` polling (corpus `cursor-always-local/dist/main.js:208675,208686`).

## Acceptance criteria
- [ ] Unit fixtures per op state, incl. linked-worktree `.git` file indirection.
- [ ] Non-git dir → undefined, no throw.
- [ ] Zero exec calls (stat-only, test-pinned).
