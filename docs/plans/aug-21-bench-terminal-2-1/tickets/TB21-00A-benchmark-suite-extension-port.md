# TB21-00A — Terminal suite registration on the shared foundation

**Priority:** P0

**Size:** M

**Depends on:** TB21-00; shared BFND-01

**Parallelizable:** no

**Live benchmark cost:** none

## Goal

Register Terminal-Bench in the shared `BenchmarkSuite`/`BenchRunConfig` contract
and unified `quanta-bench` CLI without redefining the suite type, SWE family
registry, report persistence, or dashboard dispatch.

## Shared contract consumed

[BFND-01](../../aug-21-bench-foundation/tickets/BFND-01-suite-and-config.md)
owns:

- `BenchmarkSuite = "swe-bench" | "terminal-bench"`;
- the discriminated `BenchRunConfig` union;
- legacy SWE dispatch compatibility;
- explicit-selector fail-closed behavior; and
- the rule that `DatasetFamily` is nested under `swe-bench`.

This ticket does not copy those unions. It registers the Terminal branch and its
typed value object.

## Required registration

Expected layout:

```text
src/apps/bench/
  commands/terminal.ts
  terminal/
    config.ts
    doctor.ts
    harbor-command.ts
    manifest.ts
```

Register one nested command in the existing CLI:

```text
quanta-bench terminal doctor
quanta-bench terminal canary
quanta-bench terminal run
quanta-bench terminal report
```

Existing terminal I/O, error handling, OTEL bootstrap, argv primitives, and run
identity are reused. Package scripts may be thin aliases only.

## Owner boundaries

- `src/apps/bench/commands/terminal.ts` owns nested action dispatch only.
- `src/apps/bench/terminal/*` owns Terminal run config/manifest/Harbor argv.
- `adapters/terminal-bench/*` owns the Harbor Python adapter.
- `src/apps/terminal/*` owns the agent brain.
- BFND-02 owns report persistence; TB21-04 later builds the Terminal payload.
- BFND-03 owns projector dispatch; TB21-05 later registers Terminal rendering.

Do not create `tools/terminal-bench`, widen `DatasetFamily`, or make the Terminal
command depend on jun-30 T4.

## RED rails

- `--dataset-family terminal-bench` fails.
- Terminal config/manifest containing `datasetFamily` fails.
- Terminal registration that shadows legacy SWE `run` routing fails.
- A package alias containing Harbor argv construction fails.
- A second config resolver, report root, or dashboard branch introduced by this
  ticket fails the BFND owner audit.

## Expected owner files

- `src/apps/bench/commands/terminal.ts` and focused tests
- `src/apps/bench/terminal/{config,doctor,harbor-command,manifest}.ts`
- `package.json` only for optional thin aliases

## Proof rails

```sh
bun test src/apps/bench/benchmark-suite.test.ts
bun test src/apps/bench/commands/terminal.test.ts
bun run src/apps/bench/cli.ts terminal --help
bun run src/apps/bench/cli.ts presets
bun run typecheck
bun run lint
git diff --check
```

Registration tests must exercise live resolver/dispatch calls, assert the known
suite/command floor, and prove red-on-injection.

## Definition of done

- Terminal is one registered branch of the shared suite config.
- Existing SWE commands remain behavior-compatible.
- Terminal config is typed once and passed into later commands/manifests.
- No shared foundation contract has a Terminal-local copy.

## Stop rule

If registration requires `datasetFamily === "terminal-bench"`, a second CLI, or
a product-local suite union, stop and repair BFND-01 instead.
