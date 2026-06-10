# T-402: write tool full worktree fence

**RFC:** [04·W2](../04-rfc-stale-guard-worktree-parity.md) · **Priority:** P0 · **Size:** S · **Deps:** none · **Posture:** ON (repairs default-ON control)

## Deliverable
`staleWriteGuard` AND the commit path in `src/tool/write/index.ts` resolve through `resolveEditBase(input.path, ctx.cwd, ctx.activeWorktree)` (today both use raw `ctx.cwd`: guard at `:16-31`, commit via `fs.writeFile(input.path, ctx.cwd)`), matching edit's contract.

## Acceptance criteria
- [ ] Worktree + external modification → typed stale deny.
- [ ] Same-file assertion: read→write address the same (worktree) file; session-root copy untouched.
- [ ] No-worktree path byte-identical.
- [ ] Brand-new file under worktree still allowed (unread semantics preserved).
