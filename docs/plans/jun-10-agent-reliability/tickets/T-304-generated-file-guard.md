# T-304: Generated-file edit guard across write class + snapshot-policy prompt line

**RFC:** [03·W4](../03-rfc-post-edit-regression-guards.md) · **Priority:** P1 · **Size:** M · **Deps:** T-403 (write-class guard seam in place) · **Posture:** warn ON (`=off` killswitch); hard-ask variant OFF

## Deliverable
1. Pre-commit check in the write-class deny chain (edit / write / apply_patch / scripted_replace / notebook_edit — same seam as `gitWriteGuardDeny`, `src/tool/edit/index.ts:396-397`): first-N-KiB fixed marker registry (`@generated`, `DO NOT EDIT`) or T-303's lockfile set → **warn/ask verdict**, not hard deny (regenerating goldens is sometimes the task).
2. Agent-facing prompt-pack line: snapshot/golden mismatch = real failure unless the task is explicitly snapshot-update.

## Acceptance criteria
- [ ] Marker file → warn verdict across all five write tools (mirror tests).
- [ ] Plain file byte-identical; killswitch honored.
- [ ] Prompt line pinned by prompt test.
- [ ] SOTA note: no competitor ships either mechanism (exceed-class).
