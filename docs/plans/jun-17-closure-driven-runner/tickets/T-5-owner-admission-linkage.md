# T-5: OwnerAdmission prompt/gate linkage

**Priority:** P1 · **Size:** M · **Deps:** [T-3](T-3-closure-bundle-ssot.md), [T-4](T-4-gate-decision-wiring.md) · **Posture:** OFF (`fault-evidence`)

## Deliverable

Turn `OwnerAdmission` from telemetry into action, but only minimally:

- `single-site` + `admit:true` => one concise first-edit candidate line
- `owner-family` / `cross-owner` => no forced owner hint, and commit-fast becomes stricter

This is not a raw-source hint blob. The rendered prompt section stays bounded and optional.

Prompt policy:

- inject only through the bench hint-composition seam
- never touch `src/agent/prompt.ts`
- no unconditional prompt growth

## Touch files

- new `src/runner/batch/eval/prompt-augment.ts`
- `src/agent/closure/render.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `tests/unit/owner-admission.test.ts`
- new `tests/integration/bench-owner-linkage.test.ts`

## Acceptance criteria

- [ ] `admit:true` renders exactly one bounded owner hint line.
- [ ] `owner-family` / `cross-owner` do not hard-block edits by themselves.
- [ ] Commit-fast is suppressed when sibling coverage is expected.
- [ ] Prompt path remains byte-identical when the feature is OFF or the rendered hint is empty.
- [ ] No raw source bodies are injected.

## Hellgates

- `bun test tests/unit/owner-admission.test.ts`
- `bun test tests/integration/bench-owner-linkage.test.ts`

Red cases this ticket must pin:

- owner hint always injected regardless of admission quality
- ambiguous owner cases receive a false-precision file hint
- prompt integration lands in core `prompt.ts` instead of the bench seam
