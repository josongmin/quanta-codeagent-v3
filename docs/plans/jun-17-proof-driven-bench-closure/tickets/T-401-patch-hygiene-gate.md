# T-401: patch hygiene gate + stray-file report

**Priority:** P0 · **Size:** M · **Deps:** [T-202](T-202-owner-admission-first-edit.md) · **Posture:** OFF (`patch-hygiene` knob / `QUANTA_BENCH_PATCH_HYGIENE`)

## Deliverable

Add a deterministic `PatchHygieneReport` over the final cumulative diff:

- added files
- patch file count
- files outside admitted owner set
- sanctioned generated files (`reproduce_issue.py`) allowlist
- `ownerCoverageTouched`
- `expectedSiblingCoverage`
- `missingSiblingSites[]` (telemetry-only in v1)

The report can feed `GateDecision`, but only with exact diff facts, never with vibe-based semantic-width judgments.

Version 1 blocks only exact violations:

- stray added files not on the allowlist

Everything else is telemetry first.

## Touch files

- new `src/runner/batch/eval/patch-hygiene.ts`
- `src/runner/batch/eval/driver.ts`
- `src/runner/batch/types.ts`
- `src/runner/batch/report.ts`
- new `tests/unit/patch-hygiene.test.ts`
- new `tests/integration/bench-patch-hygiene.test.ts`

## Acceptance criteria

- [ ] `reproduce_issue.py` is explicitly allowed and not flagged.
- [ ] `#16642`-class stray additions such as `.Z` / `.br` fixture files are flagged deterministically.
- [ ] Source-only diff remains the canonical patch capture.
- [ ] "Patch too semantically wide" is telemetry only in v1, not an LLM critic deny.
- [ ] Owner-family cases can report "expected sibling coverage" without turning semantic-width into a deny by itself.

## Proof rail

- `bun test tests/unit/patch-hygiene.test.ts`
- `bun test tests/integration/bench-patch-hygiene.test.ts`
