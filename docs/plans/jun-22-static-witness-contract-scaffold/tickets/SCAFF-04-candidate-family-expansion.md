# SCAFF-04 — Candidate family expansion

## Goal

Expand candidate family generation from one generic `multi-site` shared-symbol
family to typed structural families that force search coverage over likely
co-change sets.

## Files

- `src/runner/batch/eval/candidate-families.ts`
- `src/runner/batch/eval/selection-executor.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `tests/unit/candidate-families.test.ts`
- `tests/unit/family-genuineness-ratchet.test.ts`
- `tests/unit/selection-clean-mode.test.ts`

## Implementation

- Add family ids:
  - `override-family`
  - `producer-consumer`
  - `registration-callback`
  - `unique-owner`
- Map `StaticWitness` records into candidate families.
- Preserve deterministic family coverage order:
  - authoritative public contracts first;
  - typed structural families next;
  - advisory exploration families last.
- Ensure family seed text is generic and mentions structural reason, not benchmark
  case names or target paths.

## Target behavior

- For a base/backend override relation, a complete family candidate must get a
  family rank only when it touches every required owner file.
- For a producer-consumer relation, a candidate touching only the producer or only
  the consumer is incomplete.
- For registration-callback relations, a candidate changing callback arity must
  cover the registration site and callback implementation.

## Hellgate

- Shared-symbol `remove`-style noise cannot create a required family unless the
  witness is structurally authoritative.
- A family label alone has no authority; candidate satisfaction is computed from
  touched files/symbols.
- A single-site candidate cannot receive complete-family rank for a multi-site
  witness.

## Done

- Generation covers root co-change families instead of repeatedly sampling the
  same symptom owner.
- Family telemetry names the typed structural relation that produced each seed.
