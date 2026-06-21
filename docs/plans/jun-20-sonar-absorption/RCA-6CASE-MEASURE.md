# Corrected 6-Case Recoverable RCA Measurement (2026-06-21)

## Why this exists

The first 6-case RCA write-up mixed three different validation surfaces:

- repo-test regression selection (`verify-select-regression`)
- selector-side generated repro consensus (`verify-select-repro`)
- cheap module/import smoke, which is **not** currently part of the selector

That blur produced two bad conclusions:

- `xarray__xarray-2905` was counted as a repo-test regression-gate recovery, even
  though the described detector is a module smoke (`import xarray; xr.DataArray([1])`).
- the historical `baseValidatedRed` blocker from the Jun-20 local run was carried
  forward as if it still blocked current-head `verify-select-regression=discovered`,
  which is no longer true on head.

This note is the corrected measurement contract for the recoverable 6-case set.

## Datasets

- Full mixed slice:
  [rca-sixcase-recoverable.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-recoverable.jsonl)
- Repo-test regression subset:
  [rca-sixcase-regression.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-regression.jsonl)
- Repro/behavior subset:
  [rca-sixcase-repro.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-repro.jsonl)
- Smoke-only subset:
  [rca-sixcase-smoke.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-smoke.jsonl)

## Correct classification

- Repo-test regression recoverables:
  - `pytest-dev__pytest-10081`
  - `pytest-dev__pytest-10051`
- Repro/behavior validation recoverables:
  - `sympy__sympy-11618`
  - `matplotlib__matplotlib-14623`
  - `mwaskom__seaborn-3069`
- Smoke/boot failure:
  - `pydata__xarray-2905`

## Measurement rules

- Use lever-specific subsets for causal claims.
- Use the full 6-case slice only as a portfolio readout, not as attribution.
- In v3 selector experiments, say `verify-select-repro`, not `repro-vote`.
- `repro-vote` is repair-loop-only and belongs to `agentless-v2-repair` vs
  `agentless-v2-reprovote`, not the strict/noexec selector family.
- Treat `xarray__xarray-2905` as an open smoke-gap until a selector-visible smoke
  hard gate exists. Do not count it as a `verify-select-regression` win.

## Sweep A — repo-test regression selector

Goal: measure whether discovered native repo-test regression gating rejects the
two destructive/substitutive pytest patches.

- Control: `agentless-v3-thin-strict`
- Treatment: `agentless-v3-thin-strict-select`
- Optional follow-up: `agentless-v3-thin-strict-closure-select`
- Dataset:
  [rca-sixcase-regression.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-regression.jsonl)

```sh
QUANTA_RUN_ID=rca6-reg-ctl-20260621 QUANTA_BENCH_PRESET=agentless-v3-thin-strict \
  bun run src/apps/bench/cli.ts run \
  --swebench docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-regression.jsonl \
  --model gpt-5.4

QUANTA_RUN_ID=rca6-reg-sel-20260621 QUANTA_BENCH_PRESET=agentless-v3-thin-strict-select \
  bun run src/apps/bench/cli.ts run \
  --swebench docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-regression.jsonl \
  --model gpt-5.4

QUANTA_RUN_ID=rca6-reg-closure-20260621 QUANTA_BENCH_PRESET=agentless-v3-thin-strict-closure-select \
  bun run src/apps/bench/cli.ts run \
  --swebench docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-regression.jsonl \
  --model gpt-5.4
```

Readout:

- `resolved`
- `selectionTelemetry.admissibleCount`
- rejected candidates with `hard:regressionGreen=false`
- winner patch narrowness

### First readout (local, 2026-06-21)

- control `rca6-reg-ctl-20260621`:
  - preset: `agentless-v3-thin-strict`
  - result: `0/2`
  - unresolved: `pytest-dev__pytest-10081`, `pytest-dev__pytest-10051`
- treatment `rca6-reg-sel-20260621`:
  - preset: `agentless-v3-thin-strict-select`
  - result: `0/2`
  - unresolved: `pytest-dev__pytest-10081`, `pytest-dev__pytest-10051`
  - telemetry:
    - `pytest-dev__pytest-10081`: `attempted=5`, `generated=3`, `admissibleCount=0`
    - `pytest-dev__pytest-10051`: `attempted=5`, `generated=1`, `admissibleCount=0`
  - candidate verdicts:
    - every generated candidate was explicitly rejected by
      `hard:regressionGreen=false`

Interpretation:

- `verify-select-regression=discovered` is not inert on this slice. It is
  actively catching the bad pytest patches.
- The sweep did **not** recover solves because no admissible candidate survived.
- Current selector semantics still emit `winnerId="cand-0"` through the
  best-effort fallback even when `admissibleCount=0`, so this lever currently
  acts as a reject/safety oracle, not a direct recovery oracle, on this subset.
- The original RCA claim that regression gating alone would recover these two
  cases was too strong for current-head behavior.

## Sweep B — selector repro signal

Goal: measure whether selector-side generated repro consensus is the right lever
for the three right-place-wrong-synthesis / inert behavior misses.

- Base preset: `agentless-v3-select-regression`
- Dataset:
  [rca-sixcase-repro.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-repro.jsonl)
- Arms:
  - `off`: ablate the selector repro port
  - `positive`: current fail-open soft-credit mode
  - `hard`: promote repro consensus to a hard reject

```sh
QUANTA_RUN_ID=rca6-repro-off-20260621 QUANTA_BENCH_PRESET=agentless-v3-select-regression \
  QUANTA_BENCH_VERIFY_SELECT_REPRO=off \
  bun run src/apps/bench/cli.ts run \
  --swebench docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-repro.jsonl \
  --model gpt-5.4

QUANTA_RUN_ID=rca6-repro-positive-20260621 QUANTA_BENCH_PRESET=agentless-v3-select-regression \
  QUANTA_BENCH_VERIFY_SELECT_REPRO=positive \
  bun run src/apps/bench/cli.ts run \
  --swebench docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-repro.jsonl \
  --model gpt-5.4

QUANTA_RUN_ID=rca6-repro-hard-20260621 QUANTA_BENCH_PRESET=agentless-v3-select-regression \
  QUANTA_BENCH_VERIFY_SELECT_REPRO=hard \
  bun run src/apps/bench/cli.ts run \
  --swebench docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-repro.jsonl \
  --model gpt-5.4
```

Readout:

- `resolved`
- `selectionTelemetry` winner changes
- whether inert/no-op candidates stay admissible under `off` but get demoted or
  rejected under `positive` / `hard`
- false-negative rate difference between `positive` and `hard`

## Sweep C — smoke-gap confirmation

Goal: keep `xarray__xarray-2905` separate until we have an actual smoke gate.

- Dataset:
  [rca-sixcase-smoke.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-smoke.jsonl)
- Current expectation: selector presets still miss the case because no
  apply-clean/repo-test/repro selector surface catches an import-hot-path crash.
- Action after confirmation: add a cheap selector-visible smoke hard signal
  rather than inflating the `verify-select-regression` success count.

## Portfolio sanity run

After Sweeps A and B, run a mixed-slice readout only as a summary scoreboard:

```sh
QUANTA_RUN_ID=rca6-mixed-ctl-20260621 QUANTA_BENCH_PRESET=agentless-v3-thin-strict \
  bun run src/apps/bench/cli.ts run \
  --swebench docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-recoverable.jsonl \
  --model gpt-5.4

QUANTA_RUN_ID=rca6-mixed-sel-20260621 QUANTA_BENCH_PRESET=agentless-v3-thin-strict-select \
  bun run src/apps/bench/cli.ts run \
  --swebench docs/plans/jun-20-sonar-absorption/slices/rca-sixcase-recoverable.jsonl \
  --model gpt-5.4
```

Do not use this mixed readout for causal claims. The slice intentionally contains
different failure classes.
