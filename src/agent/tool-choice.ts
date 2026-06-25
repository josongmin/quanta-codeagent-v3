/**
 * tool_choice forcing as an orthogonal control gate (ADR-0079).
 *
 * Two planes, not one:
 *   - Admissibility (`admissibility-gate.ts`) gates the *result* of a tool call
 *     — it can allow / deny / steer AFTER the model has already decided to call
 *     a tool. It is a post-call plane.
 *   - This module gates the *model's freedom to call*. It steers the model's
 *     pre-call decision space by setting the LLM `tool_choice` field directly
 *     (Anthropic's `tool_choice:{type:any|none|tool|auto}`, OpenAI's
 *     `tool_choice:"required"|"none"|{type:"function",function:{name}}|"auto"`).
 *
 * The two planes are orthogonal: an admissibility deny is observed when the
 * model emits a `tool_use` we then reject; `tool_choice:"any"` forces the model
 * to emit SOMETHING but does not change what we allow it to emit; `tool_choice:
 * "none"` forbids the model from emitting any `tool_use` at all (forcing a
 * text-only terminal turn).
 *
 * ## Pure policy
 *
 * `resolveToolChoice(signals)` is a pure function over a closed signal struct
 * with explicit precedence and a `never` default branch in `switch`. It has
 * IO 0, no clock, no env, no registry. With NO signals it emits `{kind:"auto"}`
 * — which adapters map to the byte-identical pre-feature wire payload (either
 * `tool_choice:{type:"auto"}` or omitted, depending on the adapter).
 *
 * ## Precedence (exhaustive)
 *
 *   1. `explicit !== undefined`        → `explicit`
 *   2. `closeoutAttempted === true`    → `{kind:"none"}`  (force termination)
 *   3. otherwise                       → `{kind:"auto"}`  (default)
 *
 * Higher precedence wins; the explicit override beats every implicit trigger
 * so a host that wants to pin the choice (test, runbook, retry strategy) is
 * never overridden by a guard signal.
 *
 * `verifyGuardViolated` is NO LONGER a tool_choice trigger. The verify-guard
 * arms it (1-turn TTL, consumed below) but it resolves to `auto`: the guard's
 * injected nudge is evidential and explicitly invites a TEXT answer ("if you
 * already verified, say HOW and proceed"), which `{kind:"any"}` would ban. See
 * `resolveToolChoice` for the full rationale.
 *
 * ## Signal lifecycle (1-turn TTL)
 *
 * Signals are consumed at turn entry — they NEVER carry across turns:
 *   - verify-guard records a violation; the NEXT turn reads
 *     `verifyGuardViolated:true`. After that turn starts, the flag clears.
 *   - closeout-guard records an attempted closeout reminder; the NEXT turn
 *     reads `closeoutAttempted:true`. After that turn starts, the flag clears.
 *
 * The mechanism is a turn-local state object owned by the loop (`loop.ts`),
 * NOT a global. A fresh `runAgent` invocation starts with empty signals.
 */

/**
 * Closed discriminated union over the four LLM tool_choice intents we support.
 * Adapters map these 1:1 to provider-specific shapes (see `src/llm/adapters/`).
 * A `never` default branch in the switch enforces exhaustiveness at compile
 * time so adding a new variant requires updating BOTH adapters AND
 * `resolveToolChoice`.
 *
 *   - `auto` — let the model decide whether to call a tool (default).
 *   - `any`  — force the model to call EXACTLY ONE tool (any registered tool).
 *   - `none` — forbid the model from calling any tool (force a text turn).
 *   - `tool` — force the model to call the named tool specifically.
 *
 * SoT consolidation (PR-3 self-audit fix): the canonical definition lives in
 * `@/llm` (the wire-layer owner — adapters map `ToolChoice` to provider
 * payloads). This module re-exports it so `agent/` and `llm/` share one
 * compile-time identity; a future variant addition lands in one place and
 * every consumer (resolver / adapters / tests) refuses to compile if it
 * forgets a branch. `llm/` still does not depend on `agent/` — the SoT lives
 * in the lower layer.
 */
export type { ToolChoice } from "@/llm"

import type { ToolChoice } from "@/llm"

/**
 * Closed signal struct consumed by `resolveToolChoice`. Every field is optional
 * because most turns have no signals at all (the default-OFF path).
 *
 *   - `verifyGuardViolated` — set by `verify-guard.ts` when a mutating tool ran
 *     in the prior turn without a follow-up verify; the next turn reads it for
 *     1-turn-TTL state hygiene but it DOES NOT force tool_choice (resolves to
 *     `auto`). The steer is carried entirely by the guard's injected evidential
 *     nudge, which the model may satisfy with a verify tool OR a text answer.
 *   - `closeoutAttempted` — set by `closeout-guard.ts` when the 4-truth-surface
 *     closeout reminder was injected; the next turn reads it and resolves to
 *     `{kind:"none"}` so the model MUST produce a text terminal turn (it cannot
 *     keep calling tools to delay the closeout).
 *   - `explicit` — host-supplied override. Wins over every implicit signal.
 *
 * The struct is intentionally closed: no escape hatch for arbitrary hints, no
 * `Record<string,unknown>` bag. New triggers require an ADR + a new explicit
 * field so the precedence ladder stays auditable.
 */
export interface ToolChoiceSignals {
  readonly verifyGuardViolated?: boolean
  readonly closeoutAttempted?: boolean
  readonly explicit?: ToolChoice
}

/**
 * Pure resolution of {@link ToolChoiceSignals} → {@link ToolChoice} with the
 * 4-way precedence documented at the top of this file. IO 0. No clock, no env,
 * no registry. Same input always produces same output.
 *
 * Default (no signals fire) ⇒ `{kind:"auto"}` so the adapters emit a
 * byte-identical wire payload to the pre-feature path.
 */
export const resolveToolChoice = (signals: ToolChoiceSignals): ToolChoice => {
  if (signals.explicit !== undefined) return signals.explicit
  // verifyGuardViolated intentionally does NOT force tool_choice. The
  // verify-guard's injected nudge is EVIDENTIAL: it tells the model it MAY
  // answer in TEXT how it already verified ("say HOW … and proceed") OR run a
  // test. Forcing `{kind:"any"}` here mechanically BANS that text answer and
  // strands a read-only-scoped turn on a useless tool call — a self-contradicting
  // force. So the signal falls through to `auto`: the model can EITHER call a
  // verify tool OR answer in text, exactly what the nudge invites. The bit is
  // still armed/consumed for 1-turn-TTL state hygiene (see below); it just no
  // longer changes tool_choice.
  if (signals.closeoutAttempted === true) return { kind: "none" }
  return { kind: "auto" }
}

/**
 * Turn-local mutable state holding the 1-turn-TTL signal flags. The loop owns
 * one instance per session; verify-guard / closeout-guard write into it AFTER
 * a finish-time block fires; the NEXT turn entry reads the snapshot, builds
 * the signals struct, and then clears the flags so they cannot carry further.
 *
 * Kept separate from the existing per-guard state objects (`VerifyGuardState`
 * / `CloseoutGuardState`) because those track their own forcing-trip budgets,
 * which are orthogonal to the tool_choice signal lifecycle.
 */
export interface ToolChoiceTurnState {
  verifyGuardViolated: boolean
  closeoutAttempted: boolean
}

/** Fresh state for a session — no pending signals. */
export const createToolChoiceTurnState = (): ToolChoiceTurnState => ({
  verifyGuardViolated: false,
  closeoutAttempted: false,
})

/**
 * Read the pending flags into a {@link ToolChoiceSignals} snapshot AND clear
 * them so the NEXT turn after this one sees fresh state. Single call site —
 * the loop invokes it at turn entry right before `resolveToolChoice`. Pure
 * w.r.t. its arguments otherwise: only the passed `state` is mutated.
 *
 * `explicit` is sourced from the caller (host-level override threaded through
 * `AgentConfig`) and merged into the snapshot here so the resolver sees a
 * single struct.
 */
export const consumeTurnSignals = (
  state: ToolChoiceTurnState,
  explicit?: ToolChoice,
): ToolChoiceSignals => {
  const out: ToolChoiceSignals = {
    ...(state.verifyGuardViolated ? { verifyGuardViolated: true } : {}),
    ...(state.closeoutAttempted ? { closeoutAttempted: true } : {}),
    ...(explicit !== undefined ? { explicit } : {}),
  }
  state.verifyGuardViolated = false
  state.closeoutAttempted = false
  return out
}
