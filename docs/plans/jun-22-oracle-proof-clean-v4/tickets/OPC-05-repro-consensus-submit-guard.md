# OPC-05 - Repro Consensus Submit Guard

## Goal

Use generated repros as bounded positive evidence without letting a noisy repro
oracle sabotage correct candidates or admit unproven ones.

## Problem

The existing direction is correct: a single noisy repro oracle must not have
global verdict authority. But v4 also cannot treat lack of repro proof as enough
to submit. It needs a submit guard that separates positive proof, neutral/noisy
proof, and infra failure.

## Implementation

Define repro consensus states:

- `not_available`
- `no_base_red`
- `base_red_candidate_red`
- `base_red_candidate_green`
- `false_negative_suspected`
- `execution_failed`

Submit rule:

- `base_red_candidate_green` across the configured consensus threshold can admit.
- `base_red_candidate_red` can reject only when setup is valid and the repro is stable.
- `false_negative_suspected` must fail open, but it does not create positive proof.
- `not_available`, `no_base_red`, and `execution_failed` are neutral or infra, not candidate-positive.

Calibration rule:

- Gold calibration remains eval-only diagnostics.
- Calibration may explain a benchmark failure.
- Calibration may not route runtime selection or admission.

## Files

- `src/runner/batch/eval/selection-repro-consensus.ts`
- `src/runner/batch/eval/repro-oracle-calibration.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `tests/unit/selection-repro-consensus.test.ts`
- `tests/unit/repro-oracle-calibration.test.ts`

## Acceptance

- Repro consensus can produce positive proof only from executed base-red and candidate-green samples.
- False-negative handling prevents rejection but does not admit by itself.
- Gold calibration values never enter clean runtime admission.
- Reports show repro consensus state separately from public MWE and public regression proof.

## Hellgate

Do not make generated repro count or vote totals a magic heuristic. They are
evidence only after base-red and candidate-green execution are both proven.

