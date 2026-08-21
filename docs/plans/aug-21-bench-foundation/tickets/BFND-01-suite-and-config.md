# BFND-01 — suite discriminator and typed config union

**Priority:** P0

**Depends on:** jun-30 T2 typed config production wiring

## Goal

Resolve benchmark suite and all run configuration once at the existing bench
composition root, while keeping SWE dataset-family behavior nested and typed.

## Contract

```ts
type BenchmarkSuite = "swe-bench" | "terminal-bench"

type BenchRunConfig =
  | {
      benchmarkSuite: "swe-bench"
      datasetFamily: DatasetFamily
      swe: SweBenchRunConfig
    }
  | {
      benchmarkSuite: "terminal-bench"
      benchmarkVersion: "2.1"
      terminal: TerminalBenchRunConfig
    }
```

Import the canonical `DatasetFamily`; do not repeat a literal family union in the
suite module. T4 owns implementations of that family type.

## Resolution rules

- Existing no-subcommand/`run`/`grade`/`pool` flows select `swe-bench`.
- `--dataset-family` is accepted only inside the SWE branch.
- `quanta-bench terminal ...` selects `terminal-bench`.
- Absence may preserve the existing Verified default; explicit unknown or invalid
  selectors fail instead of falling back.
- Parse argv/env/defaults once. Lower in-process layers receive typed config.
- Env serialization is allowed only across a real subprocess/SSH boundary and
  must round-trip through a typed serializer/decoder.

## Expected owners

- jun-30 T2 typed config modules
- `src/apps/bench/benchmark-suite.ts`
- `src/apps/bench/cli.ts`
- suite registration modules under `src/apps/bench/`

T4's `src/apps/bench/profiles/*` remains the SWE family registry. It is not
replaced by `BenchmarkSuiteProfile`.

## RED rails

- `--dataset-family` on the Terminal subcommand fails.
- Terminal identity containing `datasetFamily` fails.
- ProMax identity containing `benchmarkSuite: "promax"` fails.
- Explicit unknown family/suite does not become Verified/SWE.
- In-process mutation of the family/suite env key fails the typed-config rail.
- Legacy SWE invocation changing dispatch target fails compatibility tests.

## Proof rails

```sh
bun test src/apps/bench/benchmark-suite.test.ts
bun test src/apps/bench/dataset-family.test.ts
bun test src/apps/bench/commands
bun run typecheck
bun run lint
```

Add runtime resolution tests for every suite/family combination. Structural
checks must require live resolver/registration calls, a known registration floor,
and red-on-injection.

## Definition of done

- Every bench command resolves one typed `BenchRunConfig`.
- SWE family selection is nested and T4-compatible.
- Terminal and ProMax extend different levels of the hierarchy.
- No product-local config resolver or in-process argv-to-env authority remains.
