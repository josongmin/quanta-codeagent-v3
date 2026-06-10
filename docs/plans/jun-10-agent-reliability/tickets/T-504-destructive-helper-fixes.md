# T-504: Destructive-helper op-state fixes

**RFC:** [05·W3b](../05-rfc-git-state-and-resume-staleness.md) · **Priority:** P1 · **Size:** M · **Deps:** T-503 · **Posture:** ON (safety extension of existing checks)

## Deliverable
For each unsafe cell from T-503: extend the helper's existing MERGE_HEAD-style refusal to the relevant T-501 op states, keeping the same `allowDirty*` override shape (`src/storage/shadow-odb/default.ts` pattern). Helpers judged safe get a code comment citing the survey instead of new checks.

## Acceptance criteria
- [ ] Rewind refuses under rebase fixture with typed error; override still works.
- [ ] Each T-503-unsafe cell covered by a test; safe cells documented in-code.
- [ ] Survey findings + dispositions recorded in the ADR.
