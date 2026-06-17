# T-701: freeze `agentless-v2` preset + report / leaderboard integration

**Priority:** P1 · **Size:** M · **Deps:** [T-302](T-302-primary-rail-enforcement.md), [T-401](T-401-patch-hygiene-gate.md), [T-501](T-501-no-patch-breaker.md), [T-601](T-601-multi-owner-escalation.md) · **Posture:** preset contract

## Deliverable

Freeze the measured bundle as a new preset only after the component metrics move:

- run a namespace preflight for `agentless-v2` / `agentless-v2-safe` / published leaderboard rows before freezing the new bundle
- add `agentless-v2` to the bench preset registry only if the name is still free; otherwise mint a fresh versioned preset name
- record the explicit knob bundle in JSON reports
- require the diagnostic sidecar beside official harness artifacts before leaderboard edits

This ticket does **not** change `agentless-v1`.

## Touch files

- `src/runner/knobs/presets.ts`
- `src/runner/batch/report.ts`
- `tests/unit/bench-preset-drives-config-hellgate.test.ts`
- `tests/unit/bench-report-knobs.test.ts`
- `docs/swebench-leaderboard.md`
- `docs/swebench-leaderboard.yaml`
- optional: `docs/analysis/swe-bench-verified-analysis/STRATEGY.md` follow-up note after measurement

## Acceptance criteria

- [ ] `agentless-v1` snapshot remains unchanged.
- [ ] `agentless-v2` is a named composition of explicit knobs only; no hidden behavior.
- [ ] Preset namespace is reconciled against already-published runs before merge; if `agentless-v2` is already overloaded, the new bundle ships under a fresh versioned name instead of silently reusing it.
- [ ] Leaderboard updates require official x86 harness artifacts plus the diagnostic sidecar.
- [ ] Reported preset / knob truth matches the runtime-applied knob vector.
- [ ] Local arm64 smoke never becomes a headline score claim for this preset.

## Proof rail

- `bun test tests/unit/bench-preset-drives-config-hellgate.test.ts`
- `bun test tests/unit/bench-report-knobs.test.ts`
