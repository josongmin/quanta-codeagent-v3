# T-SEL-02 — quarantine declaredExpected

## Goal

Remove `declaredExpected` from clean submit selection as a standalone selector authority. Keep it only as
research telemetry behind an explicitly named research gate, and route any surviving value through the generic
public-contract bundle instead of a dedicated matcher port.

## Files

- `src/runner/batch/eval/selection-declared-expected.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/knobs/knobs/rca-target-gates.ts`
- `tests/unit/selection-declared-expected.test.ts`
- `tests/unit/runner/verify-select-driver-parity.test.ts`

## Implementation

- Rename the port from selector authority language to research language:
  - current: `declaredExpected`.
  - target: `researchDeclaredExpected` or equivalent.
- Ensure clean mode never calls `applyDeclaredExpectedHardGate`.
- Keep existing regex matcher only under research/RCA gate.
- Remove exact-solution prompt literals (`RCA_*_STEER`) from the clean prompt path. If they survive anywhere, they
  must live under explicit research naming and telemetry-only wiring.
- If clean mode still extracts an issue-declared expected value from public text, route it into the generic
  public-contract bundle as one `exact-output` contract with explicit provenance.
- Emit telemetry:
  - `research.declaredExpected.match`.
  - `research.declaredExpected.family`.
  - `research.declaredExpected.wouldReject`.
- Do not let this telemetry affect candidate ranking or admissibility in clean mode.

## Hellgate

- In clean mode, a candidate with `declaredExpectedMatch=false` can still win if executable proof wins.
- In clean mode, any surviving `exact-output` contract is generic public-contract evidence, not a dedicated
  `declaredExpected` veto path.
- In research mode, telemetry records `wouldReject=true` but clean verdict remains unchanged.
- In clean mode, user prompt text contains no `RCA target gate` exact-solution steer.
- Driver parity tests prove both batch drivers wire the same mode.
- Preset tests prove no clean preset enables the research port.

## Done

- `declaredExpected` has no clean hard-veto path.
- Clean selector no longer has a dedicated instance-family patch-shape matcher surface.
- Clean prompt path contains no known-solution RCA literal.
- RCA-only analysis remains possible without contaminating benchmark claims.
