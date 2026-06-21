# T-SMK-04 — demote issue smoke to repro seed

## Goal

Stop issue smoke from acting as a standalone hard gate. Use extracted issue snippets as repro seeds or auxiliary
evidence only.

## Files

- `src/runner/batch/eval/selection-smoke.ts`
- `src/agent/verification-plan/extract-issue-repro.ts`
- `src/agent/repro-test/select.ts`
- `src/agent/verification-bundle/score.ts`
- `tests/unit/selection-smoke.test.ts`
- `tests/unit/extract-issue-repro.test.ts`
- `tests/unit/verification-bundle-score.test.ts`

## Implementation

- Keep `extractIssueRepro` as a precision-first snippet extractor.
- Route extracted snippets into repro generation/selection as a seed.
- Remove `smokeGreen=false` from clean hard rejection.
- seed / aux path는 optional helper다. repro discovery나 diagnosis에 실측 효용이 없으면 유지하지 않는다.
- If smoke execution remains, record it as:
  - `aux.issueSmoke.baseGreen`.
  - `aux.issueSmoke.patchedGreen`.
  - `aux.issueSmoke.wouldReject`.
- Let repro consensus decide only when the seed becomes part of the validated repro set.

## Hellgate

- A candidate that fails standalone issue smoke is not inadmissible in clean mode.
- A candidate that fails validated repro quorum remains inadmissible.
- Extractor false positives cannot veto a patch.
- Base smoke setup failure remains fail-open.

## Done

- `smokeGreen` has no clean hard-veto path.
- Repro seed telemetry distinguishes extracted snippet from validated repro authority.
- Seed / telemetry path는 measurable utility가 있을 때만 남는다.
