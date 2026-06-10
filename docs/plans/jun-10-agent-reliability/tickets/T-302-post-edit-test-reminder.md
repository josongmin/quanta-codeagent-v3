# T-302: Post-edit affected-test reminder (edit-class decoration)

**RFC:** [03·W2](../03-rfc-post-edit-regression-guards.md) · **Priority:** P1 · **Size:** S · **Deps:** T-301 · **Posture:** OFF (rides `QUANTA_AFFECTED_TESTS`)

## Deliverable
When the gate is ON and an edit-class tool succeeds, append a one-line reminder: "changed `X`; candidate tests: …(top entries with provenance)". Implementation: **per-tool output decoration in the edit-class tools** (the post-bash stale reminder at `src/tool/bash/index.ts:145-164` is the *pattern*, not a reusable channel — R4-L3). Dedup once per file per turn. Gives verify-guard a concrete forcing target.

## Acceptance criteria
- [ ] Reminder appears once per edited file per turn (dedup test).
- [ ] Gate OFF → byte-identical outputs.
- [ ] Covers edit, write, apply_patch, scripted_replace, notebook_edit (write-class mirror rule).
