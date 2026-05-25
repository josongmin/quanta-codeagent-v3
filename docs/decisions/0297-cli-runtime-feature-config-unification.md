# ADR-0297 — CLI runtime feature-config unification

**Status:** Accepted (2026-05-25)
**Slice:** CLI-04 — Runtime Config Unification
**Driver:** RFC may-23-structural-hexagonal-round + ongoing CLI cleanup track
**Companion:** ADR-0001 (slice isolation), ADR-0019 (4-surface posture), and the
existing `SessionRuntimeConfig` in `src/apps/cli/repl/session-runtime-config.ts`
(SESSION-level env consolidation).

---

## Context

The CLI REPL surface had grown a scatter of inline `process.env` / `isTTY`
reads inside the `build*` factories (lifecycle pills, cost panel, branch
progress, plan store, work-metrics sink, turn summary, turn indicator,
debug tracer, image queue, rewind-git port). Each gate already had a pure
`is*Enabled(env, isTTY)` helper next to its feature module — but the
factories still reached into `process.env` / `process.stdout.isTTY` /
`process.stderr.isTTY` directly to fetch the inputs for those helpers,
and `surface-compose.ts::buildPromptUx` re-parsed `QUANTA_HISTORY` +
`QUANTA_MULTILINE` inline. The result:

- 4+ globals-touching reads scattered across `repl.ts` (lines 93, 150-156).
- A second cluster in `surface-compose.ts::buildPromptUx`
  (`QUANTA_HISTORY`, `QUANTA_HISTORY_MAX`, `QUANTA_HISTORY_FILE`,
  `QUANTA_MULTILINE`).
- The boot precondition in `buildDebugTracerAndStream` re-checked
  `process.stderr.isTTY` independently from the parse-step.
- `session-setup.ts::setupSession` forwarded `runtime.env` /
  `runtime.stdoutIsTTY` / `process.stderr.isTTY` through 3-5 argument
  positions to each factory — verbose, easy to drift.

Net: every surface-level feature had its OWN read pattern. A future
non-process surface (Web/Tauri) could NOT easily swap the env source.
And a regression where someone added a NEW env knob with an inline
`process.env.X` read had no central choke-point that would fail.

`SessionRuntimeConfig` already solved the SESSION-startup half of this
problem (provider/model/mode/maxTurns/observeDir/argPrompt/idle/etc).
What was missing: a SIBLING record for the SURFACE-level (post-bootstrap)
feature gates.

## Decision

Introduce **`src/apps/cli/repl/cli-feature-config.ts`** with:

- `interface CliFeatureConfig` — typed record mirroring every
  surface-level gate (pills, costPanel, branchProgress, planStore,
  turnSummary, turnIndicator, debugTracer, imageQueue, history,
  multiline, rewindGit, workMetricsSinkEnabled, subagentForPills).
- `readCliFeatureConfig(env, stdoutIsTTY, stderrIsTTY): CliFeatureConfig`
  — pure resolver. Composes the existing `is*Enabled` / `parseDebugEnv` /
  `readPillEnvFlags` helpers; does NOT rewrite any gate's policy.

Threading:

- `setupSession()` reads `readSessionRuntimeConfig()` AND
  `readCliFeatureConfig(...)` ONCE at the orchestrator entry.
- The `SessionBootstrapDeps` / `SetupSessionDeps` factory signatures
  change from `(env, isTTY, ...)` to `(featureCfg, ...)`. Bootstrap +
  setup pass `featureCfg` down — no factory re-reads globals.
- `SessionSetupResult.featureCfg` is exposed so the host's
  `buildImageQueue`, `buildPromptUx`, `buildRewindSlashState` consume
  the same typed record.

Post-change:

- `repl.ts` build* helpers: **ZERO** direct `process.env` /
  `process.stdout.isTTY` / `process.stderr.isTTY` reads.
- `surface-compose.ts`: same — `buildPromptUx` reads from the typed
  record only. The `process.stderr.write` output sinks are unchanged
  (that's output, not env).
- `cli-feature-config.ts`: the ONE consolidation surface — and even
  inside the resolver, the only `process.*` references live in the
  module-level docstring (the runtime path reads only its arguments).

### Why a sibling record (not a merge with `SessionRuntimeConfig`)

Considered merging both records into one mega-`CliRuntimeConfig`. Rejected
because:

- **Lifecycle:** `SessionRuntimeConfig` flows into bootstrap (LLM
  selection, resume plumbing, idle guards) — read ONCE before the agent
  stack assembles. `CliFeatureConfig` flows into surface-level wiring
  (pills / cost / summary / indicator / image queue / history / multiline)
  — read ONCE at the orchestrator entry, AFTER bootstrap configured the
  LLM stack.
- **Re-use:** A future Web/Tauri surface can reuse
  `SessionRuntimeConfig` verbatim (it's surface-agnostic — provider /
  model / argv) while supplying its OWN `CliFeatureConfig` adapter
  (TTY semantics make no sense for a web surface).
- **Test surface:** keeping each record narrow lets ONE hellgate test
  pin ONE shape end-to-end. A merged record would force a single
  hellgate file to mix bootstrap-vs-surface assertions — harder to
  read, harder to maintain.

### Byte-identical preservation

Every gate's policy is preserved verbatim by **delegating to the
existing `is*Enabled` / parser helpers**. The resolver does not
re-implement any policy. Spot drift safety nets:

- `QUANTA_IMAGE_QUEUE` / `QUANTA_HISTORY` / `QUANTA_MULTILINE` continue
  to use the `(env ?? "1") !== "0"` idiom (only the literal `"0"`
  disables — `"false"`/`"off"` stay ON). Pinned by a hellgate test.
- `QUANTA_HISTORY_MAX` continues to use `Math.max(1, Number(env))`,
  so a bogus `"abc"` still produces `NaN` (the prior behavior). Pinned
  by a hellgate test (intentional drift; flipping it later requires
  conscious approval).
- `QUANTA_SPINNER_INTERVAL_MS` continues to clamp NaN/≤0 → 80; the
  `QUANTA_IMAGE_MAX_QUEUE` clamp NaN/≤0 → 5.
- `QUANTA_DEBUG`'s boot precondition (`stderr.isTTY === true`) is
  preserved by gating the resolver's `debugTracer.enabled` on
  `stderrIsTTY && parsed.enabled` — the downstream factory consumes
  the flat boolean and does not re-check the TTY.

## Consequences

### Wins

- Surface-level env reads consolidated to ONE typed record + ONE
  resolver. A new env knob added without going through
  `CliFeatureConfig` is rejected by the surface-fence hellgate
  (`process.env` grep in `repl.ts`/`surface-compose.ts`).
- Factory signatures shrink from 3-5 args to 1-2 args (`featureCfg` +
  the workload primitive — stream, statusBar, model). Easier to read,
  easier to swap.
- `setupSession`'s call sites stay byte-identical for tests (the
  factory signatures changed but the stubs were updated to match in
  one test file).
- `SessionSetupResult.featureCfg` lets the host carry the resolved
  record through to surface helpers without re-resolving.

### Trade-offs

- Adds one new file (`cli-feature-config.ts`, ~180 LOC including
  docstrings + the resolver + the `parsePlanStoreEnv` inline helper).
- Adds one new field to `SessionSetupResult` (the `featureCfg`); the
  prior 34-key shape test now pins 35 keys.
- The factory signatures changed — anything OUTSIDE the slice that
  constructed a `SessionBootstrapDeps` / `SetupSessionDeps` would
  break. As of CLI-04 the only such call site is `repl.ts` itself
  (the `sessionSetupDeps` literal); no external consumers exist.

### Out-of-scope (deliberately NOT touched)

- ASSEMBLY env reads in `internal.ts` (LLM/tooling/store/skills/etc.) —
  CLI-01's territory. The `internal.ts:548` `QUANTA_METRICS` read
  stays there; the `CliFeatureConfig.workMetricsSinkEnabled` field
  carries the same boolean for FUTURE surface consumers, but the
  bootstrap factory `buildWorkMetricsSink(enabled)` still receives
  `features.metrics !== undefined` from session-bootstrap.ts (which
  loaded the collector via internal.ts) — preserving the byte-identical
  assembly path.
- `session-commands.ts::resolveCliListEnv()` keeps using
  `runtimeConfig()` from `@/shared` (already a typed shim) +
  `process.stdout.isTTY`. That's the right boundary for the session
  subcommand and the spec explicitly accepts it.

## Verification

- `bun x tsc --noEmit` — clean on touched files (the pre-existing
  `@/observability/coverage` module-resolution errors in
  `src/tool/coverage_check.ts` + the `coverage-*` test files are
  unrelated and not introduced by this slice).
- `bun x biome check src/apps/cli/repl.ts src/apps/cli/repl/cli-feature-config.ts src/apps/cli/repl/surface-compose.ts src/apps/cli/repl/session-setup.ts src/apps/cli/repl/session-bootstrap.ts`
  — 0 errors / 0 warnings on the slice.
- `bun test tests/unit/apps/cli/cli-feature-config-hellgate.test.ts` —
  24 pass / 0 fail / 95 expect calls (this slice).
- `bun test tests/unit/apps/cli/session-setup-hellgate.test.ts
  tests/integration/session-cli-subprocess.test.ts
  tests/unit/cli/repl-extract-shape.test.ts` — all unchanged tests
  continue to pass (35-key shape lock updated to include the new
  `featureCfg` field).
- `bun test tests/unit/apps/cli/` — 323 pass / 0 fail.

## File summary

Created:

- `src/apps/cli/repl/cli-feature-config.ts` — the resolver + the typed record.
- `tests/unit/apps/cli/cli-feature-config-hellgate.test.ts` — 24-test
  hellgate (purity, default-OFF/ON matrix, env-knob sweep, surface
  fence).

Modified:

- `src/apps/cli/repl.ts` — `build*` helpers take `CliFeatureConfig`;
  zero direct env/TTY reads remain.
- `src/apps/cli/repl/surface-compose.ts` — `buildPromptUx` takes
  `CliFeatureConfig`; the `env()` import is dropped.
- `src/apps/cli/repl/session-setup.ts` — calls `readCliFeatureConfig`
  once; threads `featureCfg` through to factories; exposes
  `featureCfg` on `SessionSetupResult`.
- `src/apps/cli/repl/session-bootstrap.ts` — factory signatures
  updated; `bootstrapSession` accepts `featureCfg` and forwards.
- `tests/unit/apps/cli/session-setup-hellgate.test.ts` — stub
  factories match the new signatures; 35-key result shape lock.
- `tests/unit/apps/cli/session-loop-hellgate.test.ts` — the
  `buildSetup` literal now includes a stub `featureCfg`.

## Future work

- A second pass could split `CliFeatureConfig` further (e.g. an
  observability-only `CliObservabilityConfig` for cost / branch /
  summary / indicator / debug). Defer until a real second consumer
  exists; premature split adds noise.
- Web/Tauri surface should grow its own `WebFeatureConfig` resolver
  with TTY-equivalents replaced by viewport capability flags.
