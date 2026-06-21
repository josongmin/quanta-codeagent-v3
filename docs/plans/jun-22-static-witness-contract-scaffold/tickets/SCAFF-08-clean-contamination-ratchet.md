# SCAFF-08 — Clean contamination ratchet

## Goal

Prevent the new scaffold from reintroducing benchmark-shaped authority while
keeping research-only RCA tools available behind explicit non-clean knobs.

## Files

- `tests/unit/clean-preset-research-knob-allowlist-ratchet.test.ts`
- `tests/unit/family-genuineness-ratchet.test.ts`
- `tests/unit/public-contract-bundle.test.ts`
- `tests/unit/bench-preset-drives-config-hellgate.test.ts`
- `src/runner/knobs/presets.ts`
- `src/runner/batch/eval/selection-declared-expected.ts`
- `src/runner/knobs/knobs/rca-target-gates.ts`

## Implementation

- Ratchet every clean preset:
  - no `rca-target-gates`;
  - no declared-expected hard gate;
  - no LLM risk gate in authority mode;
  - no hidden oracle regression source;
  - no instance-shaped prompt steer.
- Add source-level forbidden literal tests for new static witness and contract
  builders:
  - no SWE-bench instance ids;
  - no known target file paths from contaminated cases;
  - no `FAIL_TO_PASS` / `PASS_TO_PASS` runtime dependency.
- Keep research presets excluded from clean score claims unless signal-off replay
  proves the same patch.

## Hellgate

- Injecting `rca-target-gates:1` into a clean preset turns tests red.
- Adding an instance id or contaminated target path literal to clean witness builders
  turns tests red.
- A research-only signal can appear in telemetry but cannot change clean
  admissibility or contract counts.

## Done

- The scaffold cannot silently drift back into case memorization.
- Clean score promotion remains mechanically separated from research RCA runs.
