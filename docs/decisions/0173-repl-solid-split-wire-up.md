# ADR-0173: runRepl SOLID split — extraction PLUS wire-up in the same PR

- Status: Accepted
- Date: 2026-05-25
- Sibling: ADR (Slice B, commit c283ad58 in this lineage) deleted 20/21
  orphan modules from the **first** attempt at this split (acb8d187,
  2026-05-24). This ADR is the second cut and binds extraction to wire-up
  in the same PR so the orphan-tree failure mode cannot recur.
- Process trigger: user MEMORY note "no-heuristics-only-validated" plus
  the "wire-or-don't-extract" lesson from Slice B's `−1437 LOC` purge.

## Context

The first split (acb8d187, "split GodClass into SOLID modules v2 —
byte-identical, current base") created 21 modules under
`src/apps/cli/repl/*.ts` but never wired any of them into `repl.ts`. The
runRepl God-function continued to inline every helper. Verification:
zero importers in `src/` or `tests/` for 20 of those 21 modules.

Slice B (c283ad58) responded by deleting 20 of the 21 modules, keeping
only `mcp-surface-wire.ts` as a marked seam (the one orphan with an
independent unit test AND a non-duplicate contract — `/mcp` slash data
surface that `repl.ts` does NOT inline). The cleanup commit message
documented the decision matrix per module.

The cleanup left `runRepl` at **~600 LOC of inline helper closures** in
a single `export const runRepl = async (): Promise<void> => { … }` body
(plus ~400 LOC of nearby module-scope helpers above). Biome cognitive
complexity exemptions are now load-bearing. The next contributor
landing in this file pays a steep onboarding tax: the spinner / status
bar / status pill / lifecycle pill / cost panel / plan store / image
queue / idle monitor / reject counter / S3 slash port wiring all
interleave with the resume FSM, the turn-cancel keypress installer, and
the seed-image drain.

A second extraction attempt without a wire-up commitment will land the
same orphan tree again. This ADR binds the next split to a different
shape: **extraction + replacement happen in the SAME PR; the inline
helper closures are deleted in the same commit they are replaced by
imports**.

## Decision

Six-module decomposition under `src/apps/cli/repl/` (re-creating the
directory Slice B emptied, EXCEPT for the kept `mcp-surface-wire.ts`).

| Module | Responsibility | Closes over | Pure / IO |
|---|---|---|---|
| **session-setup.ts** | provider+model pick, idle/reject construction, lifecycle bundle, feature load, tooling build, MCP pill seed, stream + permission wiring | env (read-only) | IO (logger, mcp client construction) |
| **session-state.ts** | `let sessionId`, `let history`, `let cwd`, `let pendingImages`, `let costDeltaPrev`, idMeta — collected into a single `SessionState` record + typed setters | nothing | pure |
| **prompt-pipeline.ts** | `buildCliPromptSource` + `wrapPromptSourceWithIdleGate` + heredoc / history wiring | promptHistory, idleMonitor, rejectCounter, statusBar | IO (stderr writes for transient hints) |
| **turn-runner.ts** | the per-turn body: signal composition, indicator start/stop, runOnce call, metrics snapshot, cost panel fold, summary render, lifecycle pill flush | sessionDeps, statusBar, indicator, summary collector, metrics, costPanel | IO (stdout/stderr) |
| **turn-cancel-install.ts** | `installTurnCancel` — stdin raw-mode keypress listener; Esc-Esc soft cancel + Ctrl+C hard exit | outer `abort`, statusBar | IO (raw stdin) |
| **session-loop.ts** | the `runInteractive` wiring with `wrapTurn` closure, plus the `argPrompt` one-shot branch | turn-runner, prompt-pipeline, session-state setters | IO (orchestration only) |

`runRepl` in `repl.ts` becomes the **composition root**: it calls
`session-setup`, threads the result into `session-state`, builds the
prompt pipeline, then dispatches to either the one-shot path or the
session-loop. Target body length: ≤ 60 LOC including imports.

### Byte-identity contract

The split is byte-identical for the default code path. Five scenarios
form the regression baseline; the PR landing the split MUST capture
stderr+stdout for each on `HEAD~1` (pre-split) and `HEAD` (post-split)
and assert byte-equality via `tests/integration/repl-byte-identity.test.ts`
(a new test bundled with this slice):

1. **default-OFF one-shot**: `quanta "hello"` with every QUANTA_* knob
   unset; non-TTY stdout/stderr piped to a fixture.
2. **default-OFF REPL line**: pipe `"hello\n"` into `quanta` (no
   argPrompt) and capture the first turn's output.
3. **idle suppress = OFF**: `QUANTA_IDLE_SUPPRESS=0 quanta "hi"`.
4. **resume by path**: `quanta --resume <path-to-fixture-session>`.
5. **plan-mode panel default off**: `QUANTA_PLAN=propose quanta "draft 3 steps"`.

If any scenario diverges by even a trailing newline, the split is
reverted (see Rollback plan).

### Risks the split has to navigate

1. **Closure captures over `let history` / `let sessionId` / `let cwd`
   / `let pendingImages`.** The current inline helpers READ these
   bindings AFTER they have been mutated by the resume FSM. Extracted
   modules cannot capture the binding by value at import time; they
   must receive a typed `SessionState` accessor (`getHistory()` /
   `setHistory(next)`) so the mutation semantics are preserved. The
   `session-state.ts` module is the SOLE owner of these `let`s.
2. **AbortSignal propagation through `turn-cancel-install.ts`.** The
   keypress listener calls `abort.abort()` (outer) or
   `turnAbort.abort()` (per-turn). Both must be passed in as
   parameters; capturing the outer `AbortController` at module
   construction time would break the per-turn `AbortSignal.any([…])`
   composition. The installer takes `(turnAbort, outerAbort,
   statusBar)` and returns `{ dispose }` — same shape as today.
3. **Status-pill race conditions.** `installPills` runs BEFORE the
   first turn AND `lifecyclePills.dispose()` runs in the outer
   `finally`. Any extraction that moves either side risks a stale
   paint AFTER scroll-region teardown (a known DECSTBM hazard that
   leaks a truncated row into the user's next shell prompt). The
   dispose ordering — `pills.dispose() → statusBar.teardown()` —
   stays in `runRepl`'s outer try/finally; modules do NOT take
   ownership of teardown.
4. **`onSessionMinted` log line ordering.** The `quanta ready (…)`
   logger.info line MUST fire BEFORE `resolveResume` for the
   legacy path and AFTER for ID-mode (preserved by the
   `inIdModeAtStart` boolean). `session-setup.ts` is the only home for
   this line; `session-state.ts` MUST NOT log.

### Rollback plan

If any byte-identity scenario fails the regression baseline OR the
biome cognitive-complexity budget is broken by the new modules' import
density, revert via:

```
git revert <split-commit-sha>
```

The revert restores the inline-helper `repl.ts` exactly. The byte-
identity test file is kept (gated by `SKIP` if the modules are absent)
so the next attempt re-enters the same regression baseline.

The orphan-tree failure mode is avoided by the wire-up contract: the
PR cannot merge if `grep -rE "from \"\\./repl/(session-setup|session-state|prompt-pipeline|turn-runner|turn-cancel-install|session-loop)\"" src/apps/cli/repl.ts` returns < 6 lines. A `tests/structural/repl-wire-up.test.ts` enforces this at CI time.

## SOTA matrix

| Project | God-function split? | Wire-up in same PR? | Byte-identity test? | Orphan guard? |
|---|---|---|---|---|
| Codex (codex-rs 0.131) | Yes (`session.rs` is ~3kLOC but call sites are typed traits) | n/a (Rust trait dispatch) | n/a | n/a |
| Cursor 3.2 (REPL agent runtime) | Partial — extracted handler modules, kept driver inline | unknown | unknown | unknown |
| Claude Code 2.1 | TUI is React; no comparable God-function | n/a | n/a | n/a |
| **quanta v1 attempt (acb8d187)** | Yes (21 modules) | **NO — orphan tree** | NO | NO |
| **quanta v2 cleanup (c283ad58)** | n/a (delete pass) | n/a | n/a | n/a |
| **quanta v3 this ADR** | Yes (6 modules) | **YES — wire-up required** | YES (5 scenarios) | YES (structural test) |

## Alternatives rejected

- **Keep the inline helpers; just shrink them.** The biome cognitive
  complexity exemptions on `runRepl` are already load-bearing; another
  knob would push the budget further. The next contributor still pays
  the onboarding tax. Rejected.
- **Extract into 12+ small modules (one per closure).** Higher import
  density, more files to audit, no functional gain over six. The
  cognitive load shifts from "long function" to "long import block" —
  Biome counts both. Rejected.
- **Move the entire body to a new file and re-export.** Doesn't reduce
  the God function — just hides it. Slice B's lesson applies: if the
  helpers aren't replacement-wired they are dead weight, not
  refactoring. Rejected.
- **Defer to a Web/Tauri surface migration.** That surface is months
  out; the maintenance burden compounds in the interim. The split
  modules stay surface-agnostic (no `process.stdin` capture at module
  load — only at function call time) so a Tauri sidecar can re-use
  `turn-runner.ts` as-is. The CLI-specific bits (raw-mode keypress,
  DECSTBM teardown) stay in `turn-cancel-install.ts` and `runRepl`'s
  outer block respectively. Rejected as a blocker — kept as a
  forward-compat design constraint.

## Follow-up

- **Land the byte-identity test fixture set.** Five baseline captures
  committed under `tests/fixtures/repl-byte-identity/` and the test
  asserts equality. The test is the gate.
- **Structural wire-up guard.** `tests/structural/repl-wire-up.test.ts`
  greps the post-split `repl.ts` for the six required imports. Catches
  a future "delete the wire-up by accident" regression.
- **Catalog truth-up.** The 11 yamls that already point at the
  Slice-B-deleted paths will need re-pointing post-split. Inventory
  captured in `tools/feature-catalog/features/10-app/repl-heuristics-
  inventory-audit.yaml` (this slice) and the parallel runRepl-split
  slice MUST update them in its own commit. Listed in the audit yaml.
