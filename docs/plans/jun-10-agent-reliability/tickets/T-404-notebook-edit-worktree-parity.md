# T-404: notebook_edit worktree keying parity

**RFC:** [04·W4](../04-rfc-stale-guard-worktree-parity.md) · **Priority:** P0 · **Size:** S · **Deps:** none · **Posture:** ON (gated tool; fix rides its gate)

## Deliverable
`notebook_edit` already calls `guardWrite` (`src/tool/notebook-edit/tool.ts:125`) but stats/writes via raw `ctx.cwd`. Route its guard key AND write target through `resolveEditBase(…, ctx.activeWorktree)`, matching edit.

## Acceptance criteria
- [ ] Worktree + external modification → typed stale deny.
- [ ] Same-file assertion (read→notebook_edit same worktree file).
- [ ] No-worktree path byte-identical.
