# T2 — typed dataset/config SSOT + fix the Pro local-path bypass

**Priority:** P1 — **this is the real start of the packet**
**Depends on:** T0 (commit the dirty acceptance-tier cluster first)
**Parallelizable:** partial

## Premise correction (read this first)

The original draft said T2 removes "argv→env mutation, e.g. dataset family bridging in cli.ts." **That mutation does not exist** — a broad grep for `process.env.X =` / `Object.assign(process.env` / `delete process.env` across all of `src/apps/bench/**` (non-test) returns empty. `cli.ts` has zero env writes.

The real problem is the opposite: dataset family is decided by **scattered raw env reads**, and the typed seam that exists is half-wired:

- `src/apps/bench/dataset-family.ts:31` `resolveDatasetFamily` reads `QUANTA_SWEBENCH_DATASET_FAMILY` (the intended SSOT)
- `remote/full.ts:477` + `remote/pool.ts:83` call `resolveDatasetFamily(undefined, process.env)` — they honor the seam but drop the argv `--dataset-family` flag (pass `undefined` for argv)
- `remote/box-session.ts:333` (`buildProEnv`) + `:376` — raw `env.QUANTA_SWEBENCH_DATASET_FAMILY` string compares. **Bypass.**
- `remote/box-session/ec2-lifecycle.ts:81,442,481` — multiple raw reads feeding `resolveSwebenchPipSpec` / `resolveSwebenchNamespace` / an `isLiveRun` gate. **Bypass.**

### The load-bearing bug (highest value in this packet)

`parseTasksForFamily` and `gradeEvaluatorForFamily` (`dataset-family.ts:38,46`) have **no production callers**. The in-process local run path uses `readSwebenchTasks` (`run-main.ts:362`) — which calls `parseSwebenchJsonl` *without* `normalizeProRow` — and `buildPythonSwebench` (`run-main.ts:699`) which calls the official evaluator *unconditionally*. So **a Pro dataset run is neither normalized nor routed to the Scale verifier → it silently mis-parses (`testCmd:"true"` no-op, fake-green risk) and mis-grades.**

This is NOT a local-only edge case. The full-remote box launches Pro by invoking the **same in-process entrypoint**: `remote/box-session.ts:380` runs `bun run src/apps/bench/cli.ts run --swebench …` → `runMain` → `run-main.ts` → the un-normalized `readSwebenchTasks` + official-only `buildPythonSwebench`. The box even provisions the Scale Pro harness/venv (`ec2-lifecycle.ts:481`) and forwards `QUANTA_SWEBENCH_PRO_*` env — but nothing in the run path reads it. Confirmed precisely: a Pro row parses via `toTask` (lowercase keys present) then hits `synthesizeTestCmd` (`dataset.ts:398`) which reads UPPERCASE `FAIL_TO_PASS` → `undefined` → `return "true"`. **Every remote Pro run today is silently vacuous-passing at the test-command level.** Fix this as part of T2 — it is the highest-value correctness win in the packet.

## Goal

Resolve bench run/grade configuration exactly once into typed objects, then thread those objects through local-run, remote-grade, and runner paths without env mutation as an authority channel.

## Scope

- bench argv parsing
- bench env/default resolution
- dataset family / profile selection inputs
- remote grade/full/pool launch config
- typed config passed into runner/runtime code

## Entry conditions

- `T1` owner boundary must be stable enough that config flow is not split across two runtime owners
- baseline `rg -n "process\\.env" src/apps/bench src/runner/batch/eval` count must be recorded in the report before editing

## Exact edit surfaces

Likely touched:

- `src/apps/bench/index.ts`
- `src/apps/bench/cli.ts`
- `src/apps/bench/dataset-family.ts`
- `src/apps/bench/remote/full.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/box-session.ts`
- `src/runner/batch/eval/driver.ts`

## Required changes

1. Introduce an explicit typed config boundary for bench.
   - acceptable shapes: `BenchRunConfig`, `BenchCliConfig`, `BenchRemoteConfig`, or an equivalent split
   - the resolved `DatasetFamily` is a typed field on it (consumed by T4's `DatasetFamilyProfile`)
2. Parse argv once, resolve env/defaults once. Fix the dropped `--dataset-family` argv on the remote path (`full.ts:477`, `pool.ts:83` pass `undefined` for argv).
3. **Fix the in-process bypass bug:** route `readSwebenchTasks`/`buildPythonSwebench` (`run-main.ts:362,699`) through `parseTasksForFamily` + `gradeEvaluatorForFamily` so a local Pro run normalizes rows and uses the Scale verifier. Add a test that a Pro fixture parses non-trivially (not `testCmd:"true"`) and grades via the Pro evaluator.
4. Replace the scattered raw `process.env.QUANTA_SWEBENCH_DATASET_FAMILY` reads (`box-session.ts:333,376`, `ec2-lifecycle.ts:81,442,481`) with the typed family field.
5. Bring the family env vars (`QUANTA_SWEBENCH_DATASET_FAMILY/_NAME/_PIP_SPEC/_NAMESPACE`) into the knob-schema SSOT — today they are raw reads outside it.
6. Keep `runtimeConfig()` or boot-level env reads only where they remain the declared boundary.

## Suggested implementation order

1. define the typed config objects
2. centralize argv parsing
3. centralize env/default resolution
4. replace argv->env mutation paths
5. thread typed config into remote and runner consumers
6. re-measure remaining `process.env` reads and classify them

## Explicit non-goals

- removing every `process.env` read from the whole repo
- touching unrelated non-bench red in `src-no-sketchy-code`
- redesigning global `runtimeConfig()` for the entire application

## Definition of done

- bench dataset family, remote mode, observe/trace decisions, and major run knobs flow through typed config
- the in-process local path routes Pro/Live through the family seam (the mis-grade bug is fixed, with a test)
- the raw family env reads in `box-session.ts`/`ec2-lifecycle.ts` are replaced by the typed field (or explicitly justified as a remote-process boundary read)
- family env vars are declared in the knob schema
- config parsing is unit-testable without launching the CLI

## Deliverables

- new or strengthened typed config module(s)
- before/after env-read count in the report
- explicit classification of remaining env reads

## Proof rails

```sh
bun run typecheck
bun test tests/unit/src-no-sketchy-code.test.ts
bun test tests/unit/bench-knob-unit-display-hellgate.test.ts tests/unit/acceptance-knob-hellgate.test.ts
rg -n "process\\.env" src/apps/bench src/runner/batch/eval
```

Report the `rg` delta and split remaining hits into:

- acceptable boot/config boundary reads
- still-open bench debt
- unrelated repo debt

## Stop rule

If a lower layer still needs an env mutation because no typed seam exists, add the seam. Do not normalize the mutation as the design.

## Blocked if

- a lower layer's behavior is still jointly owned by both app and runner code
- config decisions still depend on external live state that has no injectable seam
