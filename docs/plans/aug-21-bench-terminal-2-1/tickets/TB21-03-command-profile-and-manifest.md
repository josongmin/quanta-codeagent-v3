# TB21-03 — command, profile, and run-manifest SSOT

**Priority:** P0
**Size:** M
**Depends on:** BFND-01, TB21-00A, TB21-01, TB21-02
**Parallelizable:** no
**Live benchmark cost:** one oracle task and three canary tasks

## Goal

Replace ad-hoc shell scripts and ambient env with one typed command surface that
produces the same run manifest the adapter and canonical report builder consume.
The dashboard reads the resulting report; it does not consume runtime env or
re-resolve the manifest.

## Command surface

Extend the existing `quanta-bench` dispatcher with one nested command:

```text
quanta-bench terminal doctor
quanta-bench terminal canary
quanta-bench terminal run
quanta-bench terminal report
```

Implementation lives in `src/apps/bench/commands/terminal.ts` and focused pure
modules under `src/apps/bench/terminal/`. Existing bench terminal I/O, error
handling, OTEL bootstrap, argv primitives, and run identity are reused.

Optional `bench:tb:*` package scripts may be thin aliases only. The external
official-submission refresh belongs to TB21-05's dashboard importer and is not a
Harbor run command.

`quanta-bench terminal run` must support explicit, validated options for:

- profile;
- provider/model;
- reasoning effort;
- sandbox;
- trials (`k`);
- concurrency;
- task include set for oracle/canary only;
- output root;
- upload/public flags, defaulting off;
- clean-SHA promotion mode.

It must always resolve the canonical dataset identity from the manifest, never
from a free-form shell fragment.

## Run manifest

Create one typed manifest containing at least:

```ts
interface TerminalBenchRunManifest {
  schemaVersion: "terminal-bench-run/v2"
  benchmarkSuite: "terminal-bench"
  benchmarkVersion: "2.1"
  dataset: "terminal-bench/terminal-bench-2-1"
  datasetRef: string
  harborVersion: string
  quantaSha: string
  dirty: boolean
  agentVersion: string
  profile: "control" | "quanta-full"
  model: string
  provider: string
  reasoningEffort: string
  sandbox: string
  k: number
  concurrency: number
  timeoutMultiplier: 1
  agentTimeoutOverride: null
  verifierTimeoutOverride: null
  resourceOverrides: null
  taskSelection: "full" | { ids: string[]; purpose: "oracle" | "canary" }
  resolvedKnobs: Record<string, boolean | number | string>
}
```

The concrete serialization can differ, but these facts must have one owner.
`datasetFamily` is forbidden on this manifest.

## Config ownership

1. Parse argv with the existing bench command primitives.
2. Resolve the BFND-01 Terminal `BenchRunConfig` branch and all
   profile/default/env values exactly once at the bench composition root.
3. Reuse the existing knob inventory/runtime config for every `QUANTA_TB_*` and
   shared knob. Do not create a second env schema or independent preset engine.
4. Materialize the exact resolved value of every profile knob, including OFF
   values, in `resolvedKnobs`.
5. Derive the brain subprocess env only from this typed resolved config. Lower
   layers may read the passed env object but may not re-read ambient
   `process.env` to override it.
6. Record unknown/unregistered knobs as validation errors.

## Profiles

### `control`

- explicit comparison profile;
- no terminal lever enabled unless the benchmark requires the owned-environment
  posture as a base capability;
- never merged with `quanta-full` into one score.

### `quanta-full`

- representative product configuration;
- explicitly records `QUANTA_TB_ENV_OWNED`, `QUANTA_MAX_TURNS`,
  `QUANTA_TB_VERIFY_GATE`, output-contract, and self-test posture;
- every knob value is in the manifest, including OFF values;
- does not activate terminal-local best-of-N.

Profile resolution must produce the exact environment passed to the brain. No
second env reader may silently override it.

## Canary ownership

Do not reuse the TB2.0 smoke list. Generate the TB2.1 task catalog from the pinned
dataset and select:

- one oracle task for sandbox/verifier validation;
- three cheap, category-diverse canary tasks with bounded expected duration.

Store task IDs, dataset ref, selection rationale, and expected structural checks
in a machine-readable canary manifest. A dataset-ref change invalidates it.

## RED rails

- `terminal-bench`, `terminal-bench-2`, or `latest` as an implicit dataset must fail.
- `--dataset-family terminal-bench` and `datasetFamily: "terminal-bench"` must fail.
- Absent model/effort/profile in a paid run must fail.
- Unknown profile or knob must fail.
- Any enabled `QUANTA_TB_BEST_OF_N` plus Harbor `k` must fail until the dead knob
  is removed by TB21-06.
- `--upload` without explicit `--public`/privacy posture must not be inferred.
- Promotable run with dirty SHA or nonstandard timeout/resource overrides must fail.
- Canary manifest with a mismatched dataset ref must fail.

## Proof rails

```sh
bun run src/apps/bench/cli.ts terminal doctor
bun run src/apps/bench/cli.ts terminal run --profile quanta-full --dry-run
bun test src/apps/bench/commands/terminal.test.ts
bun test src/apps/bench/terminal
bun run typecheck
bun run lint
```

The dry-run receipt must show the final argv and redacted env names, not secret
values. An anti-vacuum test must assert the command contains the exact 2.1 dataset,
agent selector, model, effort, sandbox, `-k`, and concurrency arguments.

Add a structural test that the package aliases, if present, invoke
`src/apps/bench/cli.ts terminal ...` and contain no Harbor command construction.
Prefer runtime config reflection in the config tests. If a source guard checks
for forbidden ambient env readers, it must match a live read/call, assert a
non-zero known-reader floor, and prove red-on-injection.

## Expected owner files

- `src/apps/bench/commands/terminal.ts`
- `src/apps/bench/terminal/{config,manifest,harbor-command,canary}.ts`
- focused tests beside those modules
- machine-readable, dataset-ref-bound canary manifest
- `package.json` only for optional thin aliases

Do not add a `tools/terminal-bench` execution tree.

## Definition of done

- There is one typed run manifest from CLI to report.
- `benchmarkSuite`, not `datasetFamily`, selects Terminal-Bench.
- The manifest consumes the shared suite discriminator; it does not redeclare it.
- Terminal run/config code is part of the existing bench app.
- Knob resolution happens once and records the values actually passed to the brain.
- No active TB runner uses unversioned dataset shorthand.
- Control and product profiles are explicit and independently scored.
- Oracle/canary IDs are 2.1-derived and revision-bound.
- A paid command cannot start when the doctor or manifest validation is red.

## Stop rule

If a profile knob cannot be proven to reach the brain, do not include it in the
profile label. Fix the wiring or mark it inactive in the manifest.
