# T-507: Structured worktree merge-back

**RFC:** [05·W6](../05-rfc-git-state-and-resume-staleness.md) · **Priority:** P2 · **Size:** M · **Deps:** none · **Posture:** OFF (rides worktree tool gating)

## Deliverable
Merge-back operation on the worktree tool (`src/tool/worktree/index.ts:133-180` offers exit/status only today) reporting structured `{merged: boolean, conflicts: [{path, kind}]}` instead of raw bash output, so subagent lanes and PreHandoffSummary can show conflict state. Precedent: Codex `prepare-worktree-snapshot`/`upload-worktree-snapshot` tools (corpus `codex/.vite/build/src-B5wXNbcV.js:12210-12211`).

## Acceptance criteria
- [ ] Clean merge → `{merged: true, conflicts: []}`.
- [ ] Conflicting merge → structured conflict list, worktree left in a documented state (no silent partial merge).
- [ ] Tool registered via manifest SSOT; full wiring (zero-unwired ratchet).
