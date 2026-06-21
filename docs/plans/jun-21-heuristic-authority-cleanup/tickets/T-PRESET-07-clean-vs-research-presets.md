# T-PRESET-07 — clean vs research presets

## Goal

Separate benchmark-quality clean presets from targeted research presets.

## Files

- `src/runner/knobs/presets.ts`
- `src/config/knob-inventory.ts`
- `src/runner/batch/eval/knobs-bench.ts`
- `tests/unit/bench-preset-drives-config-hellgate.test.ts`
- `tests/unit/bench-knob-discoverability-hellgate.test.ts`
- `tests/unit/bench-sota-preset-hellgate.test.ts`

## Implementation

- Define clean preset policy:
  - no `rca-target-gates`.
  - no `declaredExpected` authority.
  - no `repro-doubt`.
  - no issue-family regex authority.
  - no discovered-regression magic-score authority.
  - no standalone issue-smoke hard gate.
- Rename or remove targeted presets from the clean ladder.
- Move targeted knobs under research naming:
  - `research/rca-target-gates/*`.
  - `research/repro-doubt/*`.
  - `research/discovered-regression/*`.
- Add preset tests that fail if clean presets enable research-only knobs.
- Guard clean presets as a CLOSED SET, not just a denylist of known-bad knobs:
  - enumerate the exact knob set each clean preset is allowed to enable in a
    checked-in allowlist.
  - a ratchet test fails when a clean preset enables ANY knob not on its
    allowlist — including a brand-new knob added later.
  - this defeats the default-opt-in hazard where a new gate seeds `1` and silently
    leaks into clean (see `cli-feature-gates-default-opt-in`); the denylist alone
    only blocks knobs we already know are bad.
  - adding a knob to a clean preset is therefore an explicit, reviewed allowlist
    edit, not an accident.

## Hellgate

- `agentless-v3-thin-strict-*` clean presets cannot enable research-only authority.
- A new knob not on a clean preset's allowlist makes the ratchet test RED, even if
  it is not on any denylist.
- Research presets are discoverable but not counted as clean benchmark profile.
- Env override can still enable research gates manually, and telemetry labels the run as research-contaminated.

## Done

- Preset ladder has no hidden targeted heuristics.
- Benchmark reports can distinguish clean score from research/RCA score.
