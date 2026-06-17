# T-3: ClosureBundle SSOT + diagnostics wiring

**Priority:** P0 · **Size:** L · **Deps:** [T-1](T-1-evaluate-success-predicate.md), [T-2](T-2-primary-rail-step.md) · **Posture:** telemetry-first

## Deliverable

Create a single `ClosureBundle` SSOT that the bench driver computes once and reuses across prompt rendering, gate input, repair selection, and diagnostics.

```ts
type ClosureBundle = {
  evidence: FaultEvidencePacket
  owner: OwnerAdmission
  plan: VerificationPlan
  gate: GateDecision
}
```

Phase 1 use:

- build once in driver pre-run assembly
- serialize onto observe/report artifacts
- feed closure diagnostics with real values
- do not yet change prompt or finish behavior unless later tickets opt in

This ticket is the anti-drift anchor. No recomputing the same closure facts in four places.

## Touch files

- new `src/agent/closure/index.ts`
- new `src/agent/closure/bundle.ts`
- new `src/agent/closure/render.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/types.ts`
- `src/runner/batch/eval/closure-diagnostics.ts`
- new `tests/unit/closure/closure-bundle.test.ts`
- new `tests/integration/bench-closure-bundle-report.test.ts`

## Acceptance criteria

- [ ] Same inputs => same `ClosureBundle`.
- [ ] Driver computes one bundle per run and reuses it.
- [ ] Report payload carries enough fields to compute `primary_rail_present_rate`, `required_verification_coverage`, and `primary_false_RED_rate`.
- [ ] OFF path stays byte-identical.
- [ ] Bundle build never reads hidden oracle material.

## Hellgates

- `bun test tests/unit/closure/closure-bundle.test.ts`
- `bun test tests/integration/bench-closure-bundle-report.test.ts`

Red cases this ticket must pin:

- duplicated local computations drift between prompt and diagnostics
- bundle contains runtime-only mutable state instead of pure closure facts
- diagnostics still report unavailable for fields the driver now has
