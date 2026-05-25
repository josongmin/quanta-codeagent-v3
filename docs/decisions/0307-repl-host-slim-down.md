# ADR-0307: CLI-06 — REPL host slim-down (lift 10 surface-adapter factories)

- Status: Accepted
- Date: 2026-05-26
- Related: ADR-0299 (CLI-01 bootstrap host extraction), ADR-0297 (CLI-04 feature-config), RFC may-22 unified-agent-runtime §3 (surface decomposition)

## Context

After CLI-01 (host bootstrap extraction, ADR-0299) `src/apps/cli/repl.ts`
had shrunk from the original monolith to ~510 LOC. The remaining body still
mixed two roles:

1. **Surface entry** (intended): top-level routing (`runRepl`,
   `runSessionMain`, `runSlashMain`, `topLevelUsage`), prompt UX, slash-ctx
   compose, turn-sink compose, and the final `runSessionLoop` call.
2. **Surface-adapter factory definitions** (accidental): 10 inline `build*`
   helpers (~200 LOC) constructing the default-OFF UX/observability
   adapters the host bootstrap consumes. These have nothing to do with
   entry routing — each is a small, single-purpose composer that maps a
   typed `CliFeatureConfig` slice to either a concrete adapter or
   `undefined` (byte-identical default-OFF).

The 10 helpers in scope:

| Helper                                | Returns                                  |
|---------------------------------------|------------------------------------------|
| `buildLifecycleBundle`                | `{pills, taskRegistry, followUpQueue}`   |
| `deriveMcpPillServers`                | `McpPillServer[]`                        |
| `buildWorkMetricsSink`                | `AgentConfig["workMetricsSink"] \| undefined` |
| `buildCostPanelOrUndefined`           | `CostPanel \| undefined`                 |
| `buildBranchProgressOrUndefined`      | `BranchProgressTracker \| undefined`     |
| `buildPlanStoreOrUndefined`           | `PlanStore \| undefined`                 |
| `buildTurnSummaryAndStream`           | `{collector, stream}`                    |
| `buildTurnIndicatorAndStream`         | `{indicator, turnStream}`                |
| `buildDebugTracerAndStream`           | `{stream, debugHandle}`                  |
| `buildTimelinePanelAndStream`         | `{stream, panel}`                        |

Each helper is a closure of the form `(featureCfg, …) => adapter | undefined`.
They share NO mutable state with the host file; nothing in `runRepl`'s
control flow depends on them living in the same module.

Keeping the helpers inline inflated the host file, blurred the role
boundary, and made each helper harder to unit-test in isolation (the
factories barrel could be smoke-tested standalone; the host file needs a
near-full bootstrap stub).

## Decision

Lift the 10 helpers into individual files under
`src/apps/cli/repl/factories/` + a barrel `index.ts`. The host file imports
the helpers via the barrel.

### Slice geometry

```
src/apps/cli/repl/factories/
  ├─ lifecycle.ts          (buildLifecycleBundle + deriveMcpPillServers + LifecycleBundle type)
  ├─ metrics-sink.ts       (buildWorkMetricsSink)
  ├─ cost-panel.ts         (buildCostPanelOrUndefined)
  ├─ branch-progress.ts    (buildBranchProgressOrUndefined)
  ├─ plan-store.ts         (buildPlanStoreOrUndefined)
  ├─ turn-summary.ts       (buildTurnSummaryAndStream + private decision-counter helpers)
  ├─ turn-indicator.ts     (buildTurnIndicatorAndStream + private buildIndicatorPort)
  ├─ debug-tracer.ts       (buildDebugTracerAndStream)
  ├─ timeline-panel.ts     (buildTimelinePanelAndStream)
  └─ index.ts              (barrel re-export)
```

Each file is 10-80 LOC: imports + (types) + the build helper + export. No
file imports from a sister app (`apps/bench`, `apps/agent`) — every import
targets either `@/<core>` (engine layer) or `../<sibling>` (CLI surface
helper). The slice fence enforced by CLI-01 between `src/host/bootstrap/`
and `src/apps/cli/` is unchanged: these factories STAY in the CLI surface
(`src/apps/cli/repl/factories/`), so the host slice still has zero CLI
imports.

### Why not move the factories into `src/host/bootstrap/factories/`?

The naive reading of "host-bootstrap layer" would suggest these belong
under `src/host/bootstrap/`. But each factory's CONCRETE adapter
(`createCostPanel`, `createTurnIndicator`, `createDebugTracer`, …) lives in
`src/apps/cli/*` because they paint TTY chrome / read CLI env. Moving the
factory wrapper alone to the host slice would force the host to import
back into `src/apps/cli/**`, violating the slice fence CLI-01 established.

The pragmatic resolution: keep the factory wrappers ADJACENT to the
concrete adapters they wrap (under `src/apps/cli/repl/factories/`), and
have the host slice declare its dep contract over OPAQUE return shapes
(`BootstrapCostPanel`, `BootstrapBranchProgress`, …). The host receives
the factories as plain function values through `SessionBootstrapDeps`; it
neither knows nor cares where they live in the CLI surface.

### Host file contents after CLI-06

The host file (`src/apps/cli/repl.ts`) now owns ONLY:

- **Top-level entry**: `runRepl`, `runSessionMain`, `runSlashMain`,
  `topLevelUsage` (kept exported — index.ts delegates here).
- **Surface-state factories**: `buildImageQueue`, `buildRewindSlashState`
  (TTY/state-binding — stay in the host).
- **CLI bootstrap closures**: `cliBuildLlm`, `cliComposeShellEvent`,
  `cliBuildIdleGuards` (ADR-0299 — env-bound CLI seams the host consumes).
- **`sessionSetupDeps` assembly**: the single literal that passes every
  factory (10 from the barrel + 3 CLI bootstrap closures + the per-call
  factories from `internal.ts`) into the host's `setupSession`.
- **Slash-ctx compose + turn-sink compose**: already handled by helpers
  imported from `./repl/surface-compose`.

The remaining LOC budget: 280 (down from 510 — a 230-LOC reduction in the
host file).

## Consequences

- **Locked**: `repl-host-slim-hellgate.test.ts` greps the post-refactor
  shape: LOC budget < 300, each helper exported by exactly one factory
  module, no inline `const buildXxx = (…)` in `repl.ts`, the barrel
  re-exports every helper, the slice fence holds (no `apps/<other>`
  imports from factories), each factory file is in the 10-80 LOC band.
- **Byte-identical**: every helper body is a verbatim move (no algorithm
  changed). The 58-case smoke battery exercises each factory with a
  default-OFF feature config and asserts the disabled-return shape
  matches the pre-refactor semantics (`stream === stream`, `undefined`
  for the optional adapters).
- **No new boundaries**: the slice fence between `src/host/bootstrap/`
  and `src/apps/cli/**` is untouched. The host's dep contract type
  (`SessionBootstrapDeps` in `src/host/bootstrap/types.ts`) is unchanged.
- **Default-OFF preserved**: each factory's gate (env knob OR feature
  config flag) is identical to the inline original. The byte-identical
  `stream` reference return (no TeeStream allocated) when an adapter is
  disabled is preserved across the move.

## Alternatives considered

1. **Inline `cliBuildLlm` / `cliComposeShellEvent` / `cliBuildIdleGuards`
   into separate factories too.** Rejected: these are surface-side
   bootstrap closures (CLI-01 invariants — they touch `node:fs`/`node:os`
   and the env directly). They're already tiny (~12 LOC each). Splitting
   them further provides no structural gain.
2. **Inline `buildIndicatorPort` as a public export in the barrel.**
   Rejected: it is a strictly-private collaborator of
   `buildTurnIndicatorAndStream` — exporting it widens the surface
   contract without a real consumer. Kept as a module-private helper
   inside `turn-indicator.ts`.
3. **Keep the helpers inline + add a separate "host responsibilities"
   comment block.** Rejected: comments do not enforce the boundary;
   the hellgate test asserting the file < 300 LOC + grep for `const
   buildXxx = (` does.

## Wire matrix

| Helper                                | Defined in (factory)          | Consumed by                              |
|---------------------------------------|-------------------------------|------------------------------------------|
| `buildLifecycleBundle`                | `lifecycle.ts`                | `sessionSetupDeps.buildLifecycleBundle`  |
| `deriveMcpPillServers`                | `lifecycle.ts`                | `sessionSetupDeps.deriveMcpPillServers`  |
| `buildWorkMetricsSink`                | `metrics-sink.ts`             | `sessionSetupDeps.buildWorkMetricsSink`  |
| `buildCostPanelOrUndefined`           | `cost-panel.ts`               | `sessionSetupDeps.buildCostPanelOrUndefined` |
| `buildBranchProgressOrUndefined`      | `branch-progress.ts`          | `sessionSetupDeps.buildBranchProgressOrUndefined` |
| `buildPlanStoreOrUndefined`           | `plan-store.ts`               | `sessionSetupDeps.buildPlanStoreOrUndefined` |
| `buildTurnSummaryAndStream`           | `turn-summary.ts`             | `sessionSetupDeps.buildTurnSummaryAndStream` |
| `buildTurnIndicatorAndStream`         | `turn-indicator.ts`           | `sessionSetupDeps.buildTurnIndicatorAndStream` |
| `buildDebugTracerAndStream`           | `debug-tracer.ts`             | `sessionSetupDeps.buildDebugTracerAndStream` |
| `buildTimelinePanelAndStream`         | `timeline-panel.ts`           | `sessionSetupDeps.buildTimelinePanelAndStream` |
