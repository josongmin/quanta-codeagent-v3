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
 *   2. `verifyGuardViolated === true`  → `{kind:"any"}`   (force re-verify)
 *   3. `closeoutAttempted === true`    → `{kind:"none"}`  (force termination)
 *   4. otherwise                       → `{kind:"auto"}`  (default)
 *
 * Higher precedence wins; the explicit override beats every implicit trigger
 * so a host that wants to pin the choice (test, runbook, retry strategy) is
 * never overridden by a guard signal.
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
 * Pure resolution of {@link ToolChoiceSignals} → {@link ToolChoice} with the
 * 4-way precedence documented at the top of this file. IO 0. No clock, no env,
 * no registry. Same input always produces same output.
 *
 * Default (no signals fire) ⇒ `{kind:"auto"}` so the adapters emit a
 * byte-identical wire payload to the pre-feature path.
 */
export const resolveToolChoice = (signals) => {
    if (signals.explicit !== undefined)
        return signals.explicit;
    if (signals.verifyGuardViolated === true)
        return { kind: "any" };
    if (signals.closeoutAttempted === true)
        return { kind: "none" };
    return { kind: "auto" };
};
/** Fresh state for a session — no pending signals. */
export const createToolChoiceTurnState = () => ({
    verifyGuardViolated: false,
    closeoutAttempted: false,
});
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
export const consumeTurnSignals = (state, explicit) => {
    const out = {
        ...(state.verifyGuardViolated ? { verifyGuardViolated: true } : {}),
        ...(state.closeoutAttempted ? { closeoutAttempted: true } : {}),
        ...(explicit !== undefined ? { explicit } : {}),
    };
    state.verifyGuardViolated = false;
    state.closeoutAttempted = false;
    return out;
};
