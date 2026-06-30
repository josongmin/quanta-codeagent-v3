# T2 — typed bench config SSOT

**Priority:** P1  
**Depends on:** T1  
**Parallelizable:** partial, after T1 owner boundary is stable

## Problem

Bench control flow still depends on `process.env` as a cross-layer control bus:

- `src/apps/bench/index.ts`
- `src/apps/bench/cli.ts`
- `src/apps/bench/remote/full.ts`
- `src/apps/bench/remote/pool.ts`
- `src/apps/bench/remote/box-session.ts`
- `src/runner/batch/eval/driver.ts`

There is also explicit argv-to-env mutation, for example dataset family bridging in `src/apps/bench/cli.ts`.

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
2. Parse argv once and resolve env/defaults once.
3. Remove control-path env mutation such as "bridge argv into env so lower layers notice".
4. Replace lower-layer `process.env` reads that decide bench behavior with typed fields wherever the owner boundary allows.
5. Keep `runtimeConfig()` or boot-level env reads only where they remain the declared boundary.

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
- no bench behavior depends on argv mutating `process.env` for lower layers
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
