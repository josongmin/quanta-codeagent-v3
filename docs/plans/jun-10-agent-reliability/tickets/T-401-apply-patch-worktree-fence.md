# T-401: apply_patch full worktree fence (guard key + write target + jail assert)

**RFC:** [04·W1](../04-rfc-stale-guard-worktree-parity.md) · **Priority:** P0 · **Size:** M · **Deps:** none · **Posture:** ON (repairs default-ON control)

## Deliverable
In `guardStaleTargets` and the apply path of `src/tool/apply-patch.ts`, resolve every update/delete target (and moveTo destination) through `resolveEditBase(op.path, ctx.cwd, ctx.activeWorktree)`; stat, `guardWrite`, **and apply** against the resolved path. Assert the fs-jail on the **resolved** path (if the jail excludes the worktree dir, surface that as its own bug — do not paper over). moveTo stale-checking is a flagged semantic addition (moves are not stale-checked today, `apply-patch.ts:431`) with its own control test.

## Evidence anchors
`src/tool/apply-patch.ts:624` (jailRoot: ctx.cwd), `:423-449` (guardStaleTargets), `:419-421` (path-identity invariant comment); read records worktree path at `src/tool/read/index.ts:305→515`; edit reference impl `src/tool/edit/index.ts:473, 403-411`.

## Acceptance criteria
- [ ] R2 trace scenario (worktree active, relative path, external mtime bump) → typed `StaleReadError` deny.
- [ ] Same-file assertion: under worktree without external modification, read→apply_patch address the same file (worktree copy changes; session-root copy untouched).
- [ ] Jail assertion on resolved path covered by test.
- [ ] No-worktree path byte-identical (existing suites green).
- [ ] moveTo stale-check pinned by separate control test.
