# RFC-07: Pre-Handoff State Summary — Structured {partialProgress, failureCause, nextActions} on Every Blocked Stop

**Status:** PROPOSED · **Priority:** P0 (north-star: agent state observability) · **Axis:** 6 (실패 UX)

## Problem statement

When the agent cannot finish — budget exhausted, hand-off-required boundary, terminal error — the user gets a stop *reason code* and a raw transcript. The three questions the project's north star says must always be answerable ("뭐 하고 있었나 / 왜 멈췄나 / 다음은 뭔가") have no answer surface at exactly the moment they matter most. Concretely:

- A `budget_exhausted` stop tells you the budget died, not what was accomplished with it or what remains.
- A hand-off-required denial appends a suffix to the *tool result* (the model sees it), but the *human* who must take over reconstructs everything from the transcript.
- `BudgetExhaustionPolicy` promises `stop-with-summary` and `emit-partial` — and the promise is hollow: the policy value is stored and **never read again**.

Everything needed to fix this already exists in pieces (StopCategory, turn-diff/files-changed ledger, decision events, partial flush, away-summary's render path). This RFC is the missing assembly, not new machinery.

## Evidence (R1 found; R2 adversarially confirmed; R3 added outcome-shape findings)

The hollow policy (smoking gun, double-verified by independent agents):

- `BudgetExhaustionPolicy` (`src/agent/budget/types.ts:72-77`) includes `"stop-with-summary"`, `"emit-partial"`. `BudgetMeter` stores it (`src/agent/budget/meter.ts:74`, default `"stop"`) — **grep finds zero consumers** of the stored value. The finish site (`src/agent/loop/turn-outcome.ts:61-72`) unconditionally returns `finish(..., "budget_exhausted", ...)` regardless of policy. Defined-but-never-dispatched.

The missing summary:

- `AgentOutcome` (`src/agent/types/agent-outcome.ts:77-128`): `reason`, `messages`, optional `stopCategory {kind, reasonCode, hint}`, `refusal` — **no** partialProgress / failureCause / nextActions fields. `Objective.nextActions` exists in-session but is never rolled into the outcome (R3 6C).
- Hand-off-required: `HANDOFF_SUFFIX` (`src/agent/dispatch-helpers.ts:22`) decorates the tool result only; no human-facing checkpoint is synthesized.
- The exhaustion decision event (`src/agent/decision-emit-phase3.ts:95-114`) is categorical telemetry, not a user summary.
- Policy choice isn't echoed in the outcome either — a host can't distinguish a clean `"stop"` halt from a truncated `"emit-partial"` (R3 6D).

Adjacent machinery that is NOT this feature (verified):

- **away-summary** (`QUANTA_ENABLE_AWAY_SUMMARY`, default-OFF) triggers only on idle-return (`src/apps/cli/repl/session-loop.ts:347-351` — `if (!wasIdle …) return`); architecturally unaware of failure stops.
- **/state** is live but pull-based (user must ask) and shows current scope/working-state, not a stop checkpoint.
- **Clean-stop is solid** (`src/agent/loop/session-lifecycle.ts:123-171` — every finish path persists + tears down): we're adding content to a reliable chokepoint, not fixing lifecycle.

Reusable parts inventory: StopCategory builders (`src/agent/stop-category.ts:133-193`, already rich: `provider.rate_limit`, `compaction.thrash`, hints), files-changed/turn-diff ledger (git-axis), budget exhaustion proposition `{kind, budget, observed}` (`src/agent/budget/meter.ts:214-248`), crash-resume partial accumulator, RFC-02's claimAudit, RFC-05's opState/drift.

## Goals

1. Every non-completed stop carries a structured, machine-readable `PreHandoffSummary` on `AgentOutcome` — populated **deterministically** (no LLM call required) at the finish chokepoint.
2. `BudgetExhaustionPolicy` actually dispatches, and the chosen policy is visible in the outcome.
3. Surfaces render it: CLI prints the checkpoint; web receives it on the agent-state push channel.

## Non-goals

- Mandatory LLM-composed prose summaries (cost + nondeterminism in the stop path; an LLM recap is an optional gated layer on top of the deterministic skeleton).
- Changing when the agent stops — only what it reports as it stops.
- Replacing away-summary or /state (different triggers; they may *consume* the new structure).

## Design sketch

```ts
// on AgentOutcome (all fields deterministic-populatable)
interface PreHandoffSummary {
  partialProgress: {
    filesChanged: ReadonlyArray<{path: string, kind: "edited"|"created"|"deleted"}>  // from turn-diff ledger
    verifyState: "passed" | "failed" | "not-run"                                      // from verify-signal history
    lastActivity: string                                                              // last tool + target, from trace
    objective?: {goal: string, nextActions: readonly string[]}                        // lifted from Objective if present
  }
  failureCause: {
    stopReason: StopReason
    category?: StopCategory                       // existing builders
    exhaustion?: {kind: string, budget: number, observed: number, policy: BudgetExhaustionPolicy}
    deniedAction?: {tool: string, layer: string}  // hand-off-required / hard-deny case, categorical only (safeReason rules)
  }
  nextActions: readonly string[]                  // deterministic templates keyed by cause (see W2)
}
```

`nextActions` are template-derived from the cause, never invented: budget/turn exhaustion → "resume with raised <kind> (observed X vs budget Y)"; hand-off-required → "human must perform <categorical action>; then resume"; verify-failed → "fix failing verification (<last failing command>) before retry"; error w/ category hint → surface the existing StopCategory hint. Unknown cause → empty array (honest), never filler.

## Workstreams (ticket-able)

### W1 — `PreHandoffSummary` type + deterministic builder
Pure builder `buildPreHandoffSummary(trace, ledger, stopInfo)` assembling the shape above from existing sources (turn-diff, verify-signal scan of the trace, budget proposition, StopCategory). Attached in `finishAgentSession` for every `reason !== "completed"` (and for completed-with-failed-verify). No I/O, no LLM, no-throw.

**Acceptance:** unit per stop class (budget, error, hand-off-deny, abort, refusal) asserting full population; property: builder never throws on arbitrary truncated traces. **Default:** ON — pure additive outcome field (hosts ignoring it are byte-compatible).

### W2 — nextActions template registry
Closed registry mapping cause → action templates (above). Categorical-only inputs in the hand-off case (reuse `safeReason` discipline — never echo commands/user input into the summary; same sanitization contract as `emitGateDecision`, `src/agent/admissibility-gate.ts:284-287`).

**Acceptance:** snapshot tests per cause; sanitization test: denied bash command's text never appears in summary.

### W3 — Dispatch `BudgetExhaustionPolicy` at the finish site
At `turn-outcome.ts:61-72`: read the stored policy; `"stop"` → today + summary; `"stop-with-summary"` → summary + (when CLI) render the checkpoint panel; `"emit-partial"` → flush accumulated partial assistant text into the final message (reuse the crash-resume partial accumulator pattern) before finishing; `"ask-user"`/`"fail-run"` per their documented semantics or explicitly removed from the enum if not implementable now (no more hollow enum values — whichever way, the type tells the truth). Echo the effective policy in `failureCause.exhaustion.policy`.

**Acceptance:** integration per policy value; hellgate: `emit-partial` produces the partial text in the outcome messages; enum has zero never-read members afterward (structural test).

### W4 — Hand-off-required human checkpoint
When the gate hard-denies with hand-off-required and the turn subsequently ends, ensure the summary's `failureCause.deniedAction` is populated from the gate's categorical decision event (plumb the last deny through session resources — the decision emitter already fires; capture it). The human-facing surface (W5) leads with it. Tool-result `HANDOFF_SUFFIX` behavior unchanged (model-facing contract stays byte-identical — the 32-cell matrix test must stay green).

**Acceptance:** integration: hand-off deny → outcome carries deniedAction; matrix e2e unchanged.

### W5 — Surface rendering
- **CLI:** checkpoint panel on non-completed stops (reuse turn-summary/away-summary render style, `src/apps/cli/turn-summary.ts`).
- **Web:** include `PreHandoffSummary` in the agent-state push channel (per jun-9 parity plan: state goes on the existing push extension, not a new transport).
- `/state` shows the last summary for a stopped session.

**Acceptance:** CLI snapshot test; web bridge event decode test (the 6-event SSOT pin — `toSessionHostTurnEvent` — must be consciously extended, not drifted).

### W6 — (Optional, gated) LLM recap layer
A short model-composed paragraph on top of the deterministic skeleton, reusing away-summary's tools-denied single-turn port (`src/agent/away-summary/port.ts`). Gate `QUANTA_PREHANDOFF_RECAP` default-OFF. Skeleton must remain complete without it.

## Risks

- Summary built during finish must never delay/poison teardown — builder is pure + no-throw; rendering failures degrade to reason-code-only (today's behavior as floor).
- Information leakage via summaries (denied commands, secrets in paths) — W2's categorical/sanitized contract, tested.
- Web event-shape SSOT is ratcheted; W5 must update the pin deliberately.

## Relations

- Direct implementation of the north-star (agent-state-observability) for the "stopped" case; consumes RFC-02 (claimAudit → failureCause), RFC-03 (drift findings), RFC-05 (opState/tree drift) as they land — each is an optional enrichment, not a dependency.
- Completes the ADR-0269 decision-event story with a human-facing counterpart; needs its own ADR (L3, full DoD bar).
