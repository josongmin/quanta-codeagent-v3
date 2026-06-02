# ADR-0443 — shift+tab permission/agent mode-cycle + input pill

**Status:** Accepted (2026-06-02)
**Type:** UX/DX slice — RFC-08 (`docs/plans/jun-2-misc/08-mode-cycle-pill.md`).
**Scope:** new `src/apps/cli/mode-cycle.ts` (pure cycle + closed-port store) + a
`shift+tab` keypress guard and a mutable meta line in `src/apps/cli/raw-line-reader.ts`
+ composition wiring through `prompt-pipeline.ts` / `surface-compose.ts` / `session-loop.ts`.
Default-OFF behind `QUANTA_MODE_CYCLE=1`.

## Context

claude-cli ships a `shift+tab` 4-posture cycle (default → accept-edits → plan →
bypass), each a color-coded pill + a one-line description, so the user always
sees "what is the agent allowed to do right now?" and can switch it in one
keystroke. quanta had `status-pills` but no input-adjacent mode pill and no
shift+tab cycle; permission mode was fixed at session start with no affordance.

A hard constraint surfaced during design: **mid-turn `PermissionMode` mutation is
not supported** — `RuntimeContext.permissionMode()` is a getter read ONCE at
`createSession`, and the REPL turn loop reuses that one session. So this is a
**turn/session-boundary** seam, not a true mid-turn switch.

## Decision

A pure `mode-cycle.ts` collapses quanta's two orthogonal mode axes
(`PermissionMode` approval posture + `AgentMode` read-only posture) into ONE
user-facing 4-rung cycle mapped 1:1 onto claude-cli's. **No new mode is invented**
— every rung projects onto an existing `PermissionMode` and `AgentMode` value
(`plan` = read-only `AgentMode` with `permissionMode:"default"`; `bypass` =
`permissionMode:"bypass"`).

A closed-port `ModeCycleStore` (`{current(), cycle()}`) mirrors the existing
`effortStore` / `identityModeState` `{get,set}` precedent. shift+tab advances it
and repaints the pill INSTANTLY; the chosen posture's `permissionMode` seeds the
next `createSession`.

### Wiring (end-to-end, default-OFF)

- `raw-line-reader.ts`: `KeyEvent` widened with `shift`; `ReadLineOptions.onCycleMode`
  added; a guard `(name:"tab" && shift) || sequence===CSI-Z` fires the hook + repaints
  a MUTABLE `metaText` row — placed BEFORE the search/Tab branches so plain Tab
  (shift falsy) and the RFC-12 @-autocomplete Tab-accept are never reached by it.
- `surface-compose.ts` `buildModeCycle(env)`: when `QUANTA_MODE_CYCLE=1`, builds the
  store + derives `modeMeta` (pill) + `onCycleMode` (cycle+repaint) — all from the ONE
  store. Merged into `buildPromptUx`.
- `prompt-pipeline.ts`: threads `modeMeta`→`meta` + `onCycleMode` into the `readLine` call.
- `session-loop.ts`: `createSession` reads `ux.modeCycle?.current().permissionMode ??
  runtimeContext.permissionMode()`.

Absent the flag ⇒ `buildModeCycle` returns `{}`, no `onCycleMode`/`meta` reach
`readLine`, the shift+tab guard early-returns → raw-line-reader + session-loop are
byte-identical (regression-anchored).

## Honest limitations (deferred)

**(1) Session-boundary, not turn-boundary.** `createSession` runs once per REPL
session, so a mid-session shift+tab repaints the pill immediately but the NEW
`permissionMode` only applies to a freshly-created session, not the next turn of
the current one. A true per-turn apply needs a runtime permission-setter seam on
`RuntimeContext` — out of scope, documented at the `createSession` call site +
RFC-08 §2.

**(2) The `plan` rung's read-only fence (`agentMode`) is NOT yet applied to the
runtime.** `RuntimeSessionConfig` (src/host/runtime/types.ts) carries
`permissionMode` / `identityMode` / `toolProfile` but has NO `agentMode` slot, so
cycling to `plan` correctly projects `permissionMode:"default"` + paints the
`[PLAN]` pill on BOTH surfaces (input meta row + bottom status bar via the
`onPosture` → `pills.update({mode})` sink), but the mutating-tool fence in
`src/agent/mode.ts` (`isMutatingToolBlockedInMode`) does not engage because the
chosen `agentMode` never reaches `createSession`. Wiring it requires threading a
new `agentMode` field through `RuntimeSessionConfig` → context-binding →
`AgentConfig.mode` — a multi-layer SDK change that overlaps another active work
stream, so it is split to a follow-up ADR. Until then the `plan` rung is a
VISUAL posture cue, not an enforced read-only gate. (The `bypass`/`acceptEdits`
rungs DO apply, since they ride the existing `permissionMode` slot.)

## Tests

`src/apps/cli/__tests__/mode-cycle.hellgate.test.ts` — 11 cases: cycle order +
wrap, store mutation/persistence, no-invented-mode projection, meta render, env
gate, unknown-key→default; and the raw-line-reader integration: shift+tab cycles
without submitting, CSI-Z backtab, plain-Tab non-collision, absent-hook no-op.
