import { classifyLLMError } from "./retry";
/** Bounded per-turn recovery budgets. These cap SAME-TURN retries so a
 *  pathological provider can never spin the loop forever; once exhausted the
 *  loop degrades gracefully (finish / accept-partial) rather than hanging. */
const MAX_TURN_STREAM_RETRIES = 3;
const MAX_OUTPUT_CONTINUES = 3;
const MAX_MALFORMED_RETRIES = 1;
const MAX_CONSECUTIVE_EMPTIES = 2;
/** Per-kind same-turn recovery budget caps (ADR documented in loop.ts:1557-1560 +
 *  recovery.ts module header). Frozen so a test asserting a cap mutates with the
 *  source rather than carrying duplicated magic numbers. */
export const RECOVERY_CAPS = Object.freeze({
    streamRetries: MAX_TURN_STREAM_RETRIES,
    outputContinues: MAX_OUTPUT_CONTINUES,
    malformedRetries: MAX_MALFORMED_RETRIES,
    consecutiveEmpties: MAX_CONSECUTIVE_EMPTIES,
});
export const freshRecovery = () => ({
    streamRetries: 0,
    outputContinues: 0,
    malformedRetries: 0,
    consecutiveEmpties: 0,
});
/** True when the assembled turn produced nothing usable: no text, no tool_use
 *  (e.g. an empty completion or a thinking-only block). */
export const isEmptyTurn = (m) => !m.content.some((b) => (b.type === "text" && b.text.trim() !== "") || b.type === "tool_use");
/** Pure policy for a thrown stream error: classify it, consult the SAME-TURN
 *  budget, and decide. Mutates `rec` (consumes a retry slot) only when it
 *  actually elects to retry — kept here so the decision is unit-testable. */
export const decideOnStreamError = (error, message, rec) => {
    const kind = classifyLLMError(error);
    if (kind === "retryable") {
        if (rec.streamRetries >= MAX_TURN_STREAM_RETRIES) {
            return { do: "error", reason: `LLM stream failed after retries: ${message}` };
        }
        const attempt = rec.streamRetries;
        rec.streamRetries += 1;
        return { do: "backoff", attempt };
    }
    if (kind === "prompt_too_long")
        return { do: "compact" };
    return { do: "error", reason: message };
};
/** Pure policy for a successfully assembled turn: decide whether it is final,
 *  needs a SAME-TURN nudge+retry (output-limit / malformed / empty), or should
 *  proceed to tool dispatch. Mutates `rec` only when it elects a nudge/retry. */
export const decideOnAssembled = (stopReason, message, rec) => {
    // ADR-0076 Gap-1: provider refusal / abnormal non-tool stop. The model
    // stopped with an explicit refusal (Anthropic `refusal`, OpenAI content-
    // policy stop). Surface it as an error so the run does NOT report the
    // refusal text as a normal completion — the pre-ADR fall-through bug routed
    // every unrecognized stop_reason to `proceed`→`completed`, disguising a
    // refusal as success. `pause_turn` (server-tool resume) is intentionally
    // NOT handled: we ship no server-side tools, so it cannot be emitted; adding
    // a dead branch would be cargo.
    if (stopReason === "refusal") {
        return {
            do: "error",
            reason: "Model refused to continue (stop_reason=refusal); the assistant " +
                "message carries the refusal rationale, not a completed task.",
        };
    }
    if (stopReason === "max_tokens" && rec.outputContinues < MAX_OUTPUT_CONTINUES) {
        rec.outputContinues += 1;
        return {
            do: "nudge",
            keepMessage: true,
            text: "Output limit hit — continue exactly where you left off, do not repeat.",
            reason: "nudge",
        };
    }
    const hasTools = message.content.some((b) => b.type === "tool_use");
    if (stopReason === "tool_use" && !hasTools) {
        if (rec.malformedRetries < MAX_MALFORMED_RETRIES) {
            rec.malformedRetries += 1;
            return {
                do: "nudge",
                keepMessage: true,
                text: "Your previous tool call was malformed/incomplete. Re-issue it as a " +
                    "single valid tool call.",
                reason: "malformed",
            };
        }
        return { do: "completed" };
    }
    if (!hasTools && isEmptyTurn(message)) {
        if (rec.consecutiveEmpties >= MAX_CONSECUTIVE_EMPTIES)
            return { do: "completed" };
        rec.consecutiveEmpties += 1;
        return {
            do: "nudge",
            keepMessage: true,
            text: "You returned an empty response. Continue the task or give your final answer.",
            reason: "empty",
        };
    }
    rec.consecutiveEmpties = 0;
    return { do: "proceed" };
};
