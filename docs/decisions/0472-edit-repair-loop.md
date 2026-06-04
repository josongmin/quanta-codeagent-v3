# ADR-0472 — Edit-repair-loop: lint-delta + bounded fast-model repair to green

**Status:** Accepted (2026-06-03)
**Type:** New default-OFF feature slice (`@/agent/edit-repair-loop`).
**Scope:** new files under `src/agent/edit-repair-loop/` (`types.ts`,
`lint-delta.ts`, `runner.ts`, `index.ts`) + the hellgate
`tests/unit/edit-repair-loop-hellgate.test.ts` + this ADR + the feature-catalog
yaml. NO shared files edited (integration is a human-applied TODO list below).
**Default-OFF:** `QUANTA_EDIT_REPAIR_LOOP` unset (or any value other than `"1"`)
⇒ `editRepairLoopEnabled` is `false` ⇒ the integration site skips the loop
entirely; the ports are never constructed, no extra LLM/check calls happen,
byte-identical to today. The lint-delta computer is pure and can enrich edit
output independently.

## Context

Cursor and Codex both run a short **repair loop** after a model edit: re-check
the file (lints / type-check / named tests / a command), and if the edit broke
something, re-drive a fast edit model with the failure fed back — bounded by a
small iteration cap — before handing a still-broken file back to the main turn.
Two primitives make this work without blaming the model for the file's existing
debt:

1. **lint-delta** — diff the diagnostics BEFORE the edit against AFTER, surface
   only what the edit INTRODUCED, and attach it to the edit tool's
   `toModelOutput`. This is the high-signal feedback ("your edit added these
   lints"), not a wall of pre-existing warnings.
2. **bounded repair loop** — re-drive the fast model until the check is green or
   `maxIters` is exhausted, feeding each failure back with per-loop custom
   instructions.

## Decision

A pure, port-inverted slice under `@/agent/edit-repair-loop` (imports `@/shared`
ONLY — Result/ok/err, errMessage):

- **`computeLintDelta(preDiags, postDiags)`** — pure count-aware multiset
  difference. Identity is the `(file, line, code, message)` tuple
  (`diagnosticKey`), deliberately EXCLUDING column + severity so a benign column
  shift or severity change never registers as introduced. Multiplicity is
  honoured (pre had 1, post has 2 ⇒ exactly 1 reported). `renderLintDelta`
  formats the result for `toModelOutput` (empty ⇒ explicit "no new diagnostics").

- **`editRepairLoopEnabled(env)`** — strict `=== "1"` gate over INJECTED env
  (never `process.env`).

- **`runRepairLoop(cfg, deps, signal)`** — bounded loop over two INJECTED ports
  (port inversion, mirrors `src/permission/classifier.ts` ClassifierPort and the
  `away-summary` SummarizeFn): `RepairCheck` (returns the current `RepairFailure`
  or `null` when green) and `RepairReactorPort` (the fast edit model: failure +
  custom instructions ⇒ one applied/declined attempt). The composition root
  adapts the real LSP diagnostics source onto `RepairCheck`/`DiagnosticsProvider`
  (for `lints`, computing the delta via `computeLintDelta`) and the real
  fast-apply executor (`src/agent/fast-apply-fallback` side-conversation, with
  `src/tool/parse-test-failure` providing the `tests`/`command` failure signal)
  onto `RepairReactorPort` — this slice imports NEITHER directly (slice fence;
  they are inverted as port TYPES). `maxIters` is a REQUIRED config field, must
  be an integer ≥ 1 — no magic number. Every exit returns a structured
  `RepairLoopReport` over a closed `RepairStopReason` union (green / exhausted /
  model-declined / check-error / aborted / invalid-config). NO-THROW: a port
  throw is caught (check throw ⇒ check-error, reactor throw ⇒ model-declined);
  abort is honoured before every port call.

`check ∈ {lints | tests | command}` is the closed `CheckKind` union.

## Negative invariants

- The slice never imports `@/llm`, `@/tool`, `@/agent/fast-apply-fallback`, or
  `@/tool/parse-test-failure` — those are inverted as port TYPES.
- No `process.env` read inside the slice.
- No arbitrary threshold: the only bound is the REQUIRED `maxIters`.
- Pre-existing diagnostics are never reported as introduced (multiset diff).
- Default-OFF path is byte-identical: the integration site gates on
  `editRepairLoopEnabled` BEFORE constructing the ports.

## Integration TODOs (human applies; this slice is fenced from shared files)

1. **edit/write/apply-patch result render — attach lint-delta.** At each edit
   tool's `toModelOutput` site (`src/tool/edit/**`, `src/tool/write/**`,
   `src/tool/apply-patch/**`), when the gate is ON: call the host
   `DiagnosticsProvider` for the file BEFORE the edit and AFTER, then append
   `renderLintDelta(computeLintDelta(pre, post))` to the model output. When the
   gate is OFF, do nothing (today's output).
2. **Loop call site after a tool edit.** In the dispatch/loop seam
   (`src/agent/dispatch.ts` or the post-edit hook), after a mutating edit tool
   returns and the gate is ON, construct `RepairLoopDeps` and call
   `runRepairLoop({file, checkKind, maxIters, customInstructions}, deps, signal)`;
   render the `RepairLoopReport` into the transcript.
3. **Fast-model port wiring (composition root, `src/apps/**`).** Adapt the real
   LSP/diagnostics source onto `RepairCheck` (lints ⇒ `computeLintDelta`) and the
   `fast-apply-fallback` side-conversation + `parse-test-failure` onto
   `RepairReactorPort`. Source `maxIters` from a named config field (no literal).

## Integration status — LANDED (H1, jun-04)

TODOs 1 and 2 plus the config-field half of TODO 3 are now wired in
`src/agent/dispatch.ts` (gated on `QUANTA_EDIT_REPAIR_LOOP`):

- **TODO 1 (lint-delta attach)** — `openLintBracket` snapshots `DiagnosticsProvider`
  diagnostics pre/post a path-bearing `edit`/`write` and appends
  `renderLintDelta(computeLintDelta(pre, post))` to the tool output.
- **TODO 2 (loop call site)** — the LINT repair loop runs inside the bracket
  (`checkKind:"lints"`), and a separate, provider-INDEPENDENT
  `runEditCommandRepair` runs the COMMAND loop (`checkKind:"command"`,
  LoopOnCommand / LoopOnTests parity) after the edit.
- **TODO 3 (named config field)** — `maxIters` + `customInstructions` are sourced
  from the new `AgentConfig.editRepair` field (`resolveRepairMaxIters` validates
  `int ≥ 1`, else the `REPAIR_MAX_ITERS=2` default); the command check is wired via
  `commandRepairCheck(exec, command)`. Both loops share `buildEditApplyReactor`.

Tests: `tests/unit/edit-repair-command-loop-hellgate.test.ts` proves the command
loop end-to-end through the real `dispatchTool` + `editTool` (fail → re-edit →
green; maxIters bound; byte-identical default-OFF).

Remaining (deployment / scope, NOT a code hold): the composition root injects the
real fast `LLMPort` (`config.llm`), LSP `DiagnosticsProvider`
(`config.diagnosticsProvider`) and command `ExecRunner` (`config.editRepair.exec`);
and `apply_patch` coverage stays deferred (`extractEditPath` is `edit`/`write`
only — multi-file patch is out of scope here).
