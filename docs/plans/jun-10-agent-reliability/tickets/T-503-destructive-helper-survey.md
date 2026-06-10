# T-503: Destructive-helper op-state survey

**RFC:** [05·W3a](../05-rfc-git-state-and-resume-staleness.md) · **Priority:** P1 · **Size:** S · **Deps:** T-501 · **Posture:** survey-only

## Deliverable
Survey every destructive helper for git op-state blind spots: shadow-odb rewind family (`src/storage/shadow-odb/default.ts:536-586` — checks MERGE_HEAD only today), file-history rewind, checkpoint three-way restore (`src/agent/per-tool-checkpoint/three-way-restore.ts`). Per helper: safe / unsafe verdict + why, against each T-501 op state. Output scopes T-504.

## Acceptance criteria
- [ ] Written verdict per helper × op-state with code evidence.
- [ ] T-504 scope list produced (unsafe cells only).
