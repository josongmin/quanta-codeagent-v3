# RFC-07 (FINAL): Pre-Handoff State Summary — Structured {partialProgress, failureCause, nextActions} on Every Blocked Stop

**Status:** FINAL · **Priority:** P0 (north-star: agent state observability) · **Axis:** 6 (실패 UX)
**R4 revision:** `emit-partial` semantics redefined (the previous wording was unimplementable at the finish seam); `filesChanged` now trace-derived (turn-diff ledger is opt-in); W5 split CLI/web (web channel not yet landed).

## Problem statement

When the agent cannot finish — budget exhausted, hand-off-required boundary, terminal error — the user gets a stop *reason code* and a raw transcript. The north-star questions ("뭐 하고 있었나 / 왜 멈췄나 / 다음은 뭔가") have no answer surface at exactly the moment they matter most. And `BudgetExhaustionPolicy` promises `stop-with-summary` / `emit-partial` while the stored policy value is **never read again** — a hollow enum in a safety-adjacent type.

Everything needed exists in pieces (StopCategory, tool trace, decision events, away-summary's render style). This RFC is the missing assembly.

## Evidence (R1 → R2 double-confirmed → R4 seam-verified)

- **Hollow policy:** `BudgetExhaustionPolicy` (`src/agent/budget/types.ts:72-77`) includes `"stop-with-summary"`, `"emit-partial"`. `BudgetMeter` stores it (`src/agent/budget/meter.ts:74`, default `"stop"`); repo-wide grep finds **zero readers**. R4 note: `exhaustion` is a **public readonly field** (`meter.ts:51`) — the read is trivially available to the finish site; only the behavior was never built.
- **Finish site ignores it:** `src/agent/loop/turn-outcome.ts:61-73` unconditionally `finish(..., "budget_exhausted", ...)`.
- **No summary fields:** `AgentOutcome` (`src/agent/types/agent-outcome.ts:77-128`) — reason, messages, optional StopCategory/refusal; no partialProgress/failureCause/nextActions. `Objective.nextActions` exists in-session, never rolled up.
- **Hand-off:** `HANDOFF_SUFFIX` (`src/agent/dispatch-helpers.ts:22`) decorates the tool result (model-facing) only.
- **away-summary is idle-return-only by construction:** `src/apps/cli/repl/session-loop.ts:347-351` (`if (!wasIdle …) return`).
- **R4 seam facts (constrain the design):**
  - At `resolveTurnLoopOutcome`, the last assistant message is **complete** and pending tool results are already appended (`turn-outcome.ts:63-65`) — there is no "partial text" to flush at this seam.
  - The crash-resume partial accumulator lives across the slice fence (`@/runner` subscribing to `RuntimeSession` events) and is not reachable from `@/agent` — the previous "reuse the accumulator" wording was wrong.
  - turn-diff ledger is **opt-in** (ADR-0125; `types.ts:1155`) — cannot be the primary source for `filesChanged`.
- Reusable parts: StopCategory builders (`src/agent/stop-category.ts:133-193` — already rich, with hints), budget proposition `{kind, budget, observed}` (`meter.ts:214-248`), sanitization contract (`emitGateDecision`, `admissibility-gate.ts:284-287`), away-summary render style, RFC-02 claimAudit / RFC-05 opState as optional enrichments.

## SOTA alignment (R4 corpus)

- **Cursor** ships the strongest *content* baseline: a dedicated continuation-summary prompt ("identify user's explicit requests, your approach, key decisions… file names, snippets, errors, user feedback — this summary will be provided to another AI assistant to continue the task"; `cursor-agent-exec/dist/main.js:~154897`). It is LLM-composed and aimed at agent-to-agent handoff, not a structured machine artifact.
- **Claude Code** ships the strongest *limit UX*: real-time "Context left until auto-compact: X%", compaction circuit breaker (stop after 3 failed compacts with actionable error), grey "Interrupted" + task panel, `/resume` picker with conversation summaries (corpus changelog v1.3537, v1.1286, v2.2717).
- **Codex:** resume toasts only.
- **Nobody ships a structured, machine-readable stop artifact** (`{partialProgress, failureCause, nextActions}` on the outcome) nor policy-dispatched exhaustion behavior. W1-W4 are exceed-class. Absorb moves folded in: Cursor's summary content checklist shapes W6's recap rubric; Claude Code's actionable-error style shapes the nextActions templates.

## Goals

1. Every non-completed stop carries a structured `PreHandoffSummary` on `AgentOutcome`, populated **deterministically** at the finish chokepoint.
2. `BudgetExhaustionPolicy` actually dispatches; the enum contains zero never-read members afterward; the effective policy is echoed in the outcome.
3. Surfaces render it: CLI immediately; web when its push channel lands.

## Non-goals

- Mandatory LLM-composed prose in the stop path (cost/nondeterminism) — optional gated layer only (W6).
- Changing *when* the agent stops — only what it reports.
- Replacing away-summary or `/state` (different triggers; both may consume the new structure).

## Design (R4-corrected)

```ts
interface PreHandoffSummary {
  partialProgress: {
    filesChanged: ReadonlyArray<{path: string, kind: "edited"|"created"|"deleted"}>
      // PRIMARY: derived from edit-class tool successes in the trace (wm) —
      // always available. turn-diff ledger, when wired, ENRICHES (rename/diffstat).
    verifyState: "passed" | "failed" | "not-run"     // verify-signal scan of the trace
    lastActivity: string                              // last tool + target from trace
    objective?: {goal: string, nextActions: readonly string[]}  // lifted if present
  }
  failureCause: {
    stopReason: StopReason
    category?: StopCategory
    exhaustion?: {kind: string, budget: number, observed: number, policy: BudgetExhaustionPolicy}
    deniedAction?: {tool: string, layer: string}      // categorical only (safeReason rules)
    truncated?: boolean                                // emit-partial marker, see W2
  }
  nextActions: readonly string[]                       // template registry, never invented
}
```

`nextActions` templates (Claude-Code-style actionable errors): budget/turn → "resume with raised <kind> (observed X vs budget Y)"; hand-off-required → "human must perform <categorical action>; then resume"; verify-failed → "fix failing verification (<last failing command>) before retry"; error → surface StopCategory hint. Unknown → empty array, never filler.

## Workstreams (ticket-able; see tickets/T-701..706)

### W1 — `PreHandoffSummary` type + deterministic builder + nextActions registry
Pure `buildPreHandoffSummary(wm, stopInfo, opts)` assembling the shape above from the trace (edit-class successes → filesChanged; verify-signal matchers → verifyState; budget proposition; StopCategory). Template registry included (tightly coupled, same ticket). Sanitization: categorical-only in deniedAction/templates — denied command text never appears (test-pinned, same contract as `emitGateDecision`). Attached in `finishAgentSession` (`session-lifecycle.ts:123` — `wm` and cfg in scope) for every `reason !== "completed"`, plus completed-with-failed-verify. No I/O, no LLM, no-throw.

**Acceptance:** unit per stop class (budget/error/hand-off/abort/refusal) asserting full population; property: never throws on truncated traces; sanitization test. **Default:** ON (additive outcome field; registered in the default-posture table in 00-index).

### W2 — `BudgetExhaustionPolicy` dispatch at the finish site (truth-telling enum)
Read `meter.exhaustion` (public) in `resolveTurnLoopOutcome` / finish:
- `"stop"` → today's behavior + W1 summary.
- `"stop-with-summary"` → summary + surface-rendered checkpoint (W4's CLI panel is the renderer).
- `"emit-partial"` → **redefined to its implementable turn-boundary semantic:** guarantee all in-flight turn artifacts (final message + appended tool results — already in `wm` at this seam) appear in `outcome.messages`, and set `failureCause.truncated: true` so hosts can distinguish a mid-task halt from a clean stop. (The old "flush partial streamed text" reading is impossible here: text is complete at turn boundary, and the crash-resume accumulator is across the slice fence. Mid-turn token flushing remains crash-resume's job, ADR-0528 L3.)
- `"ask-user"` / `"fail-run"`: implement per documented semantics **or remove from the enum** in this ticket — whichever way, the type stops lying. Echo the effective policy in `failureCause.exhaustion.policy`.

**Acceptance:** integration per policy value; structural test: enum has zero never-read members; hellgate: `emit-partial` outcome carries truncated marker + complete in-flight messages.

### W3 — Hand-off-required human checkpoint capture
When the gate hard-denies with hand-off-required, capture the categorical decision (the decision emitter already fires — plumb the last deny into session resources) so W1 populates `failureCause.deniedAction`. Model-facing `HANDOFF_SUFFIX` byte-identical; the 32-cell matrix e2e must stay green.

**Acceptance:** integration: hand-off deny → outcome carries deniedAction; matrix unchanged.

### W4 — CLI rendering + `/state`
Checkpoint panel on non-completed stops (away-summary/turn-summary render style, `src/apps/cli/turn-summary.ts`); `/state` shows the last summary for a stopped session.

**Acceptance:** CLI snapshot tests per stop class.

### W5 — Web push (BLOCKED-BY: jun-9 parity Tier B agent-state channel)
Include `PreHandoffSummary` in the agent-state push when that channel lands; the web-bridge 6-event SSOT pin (`toSessionHostTurnEvent`) must be deliberately extended. Separate ticket so W1-W4 aren't blocked.

### W6 — (Optional, gated) LLM recap layer
Short model-composed paragraph on the deterministic skeleton, reusing away-summary's tools-denied single-turn port (`src/agent/away-summary/port.ts`); recap rubric absorbs Cursor's continuation-summary content checklist (requests/approach/decisions/files/errors/feedback). Gate `QUANTA_PREHANDOFF_RECAP` default-OFF. Skeleton complete without it.

## Risks

- Builder must never delay/poison teardown — pure + no-throw; render failures degrade to reason-code-only (today's floor).
- Information leakage — categorical/sanitized contract, test-pinned (W1).
- Web event-shape ratchet — W5 updates the pin deliberately.

## Relations

- North-star implementation for the "stopped" case; optional enrichments from RFC-02 (claimAudit), RFC-03 (drift), RFC-05 (opState/tree drift) as they land — none are dependencies.
- Completes ADR-0269 decision events with a human-facing counterpart; own ADR required (L3 DoD bar).
