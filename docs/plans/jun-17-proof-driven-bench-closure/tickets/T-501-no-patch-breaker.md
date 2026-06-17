# T-501: post-localization commit rail + `no_patch_exhausted` verdict

**Priority:** P1 · **Size:** M · **Deps:** [T-202](T-202-owner-admission-first-edit.md) · **Posture:** OFF (`no-patch-breaker` knob / `QUANTA_BENCH_NO_PATCH_BREAKER`)

## Deliverable

Close the `#9296` class structurally without inventing a new generic turn heuristic:

- once Phase 1 is over
- and owner admission is high-confidence single-owner
- and patch is still empty

inject one non-repeating rail telling the agent to make the smallest best edit now before more broad exploration.

This is the explicit `commit-fast` inverse of T-302's verify gate: high-confidence / low-ambiguity / empty-patch runs should stop deliberating and commit a bounded best edit.

If the run still exits empty, classify it as `no_patch_exhausted`, not as a generic model miss.

## Touch files

- `src/agent/localize-phase-guard.ts`
- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`
- `src/runner/batch/types.ts`
- `src/runner/batch/report.ts`
- `src/config/knob-inventory.ts`
- new `tests/unit/no-patch-breaker.test.ts`
- existing `tests/unit/localize-phase-guard-hellgate.test.ts`

## Acceptance criteria

- [ ] Rail fires only when owner admission is high-confidence and the patch is still empty.
- [ ] Low-confidence / multi-owner runs are unaffected.
- [ ] Empty-patch terminal runs after the rail are classified distinctly.
- [ ] Ticket introduces no new global idle threshold beyond the existing localization boundary.
- [ ] Ticket may consume existing budget pressure as a one-way anti-loop signal, but it does not introduce a new open-ended heuristic counter.

## Proof rail

- `bun test tests/unit/no-patch-breaker.test.ts`
- `bun test tests/unit/localize-phase-guard-hellgate.test.ts`
