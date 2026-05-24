import type { assembleFromEvents } from "@/llm"
import { classifyLLMError } from "./retry"

/** Bounded per-turn recovery budgets. These cap SAME-TURN retries so a
 *  pathological provider can never spin the loop forever; once exhausted the
 *  loop degrades gracefully (finish / accept-partial) rather than hanging. */
const MAX_TURN_STREAM_RETRIES = 3
const MAX_OUTPUT_CONTINUES = 3
const MAX_MALFORMED_RETRIES = 1
const MAX_CONSECUTIVE_EMPTIES = 2

/** Per-kind same-turn recovery budget caps (ADR documented in this module
 *  header + the conversation_action_noop branch of loop.ts). Frozen so a test
 *  asserting a cap mutates with the source rather than carrying duplicated
 *  magic numbers. */
export const RECOVERY_CAPS = Object.freeze({
  streamRetries: MAX_TURN_STREAM_RETRIES,
  outputContinues: MAX_OUTPUT_CONTINUES,
  malformedRetries: MAX_MALFORMED_RETRIES,
  consecutiveEmpties: MAX_CONSECUTIVE_EMPTIES,
} as const)

/** Assembled-message shape produced by `assembleFromEvents`. Re-exported by
 *  `loop.ts` so existing `@/agent/loop` consumers keep importing it from there. */
export type AssembledMessage = ReturnType<typeof assembleFromEvents>["message"]

/** Stable, small set of `recovery` reasons (RFC-0002 §5.2). Group E maps these
 *  → trajectory kinds; keep the set closed so probe/triage can rely on it. */
export type RecoveryReason =
  | "backoff"
  | "compact"
  | "nudge"
  | "empty"
  | "malformed"
  | "unverified"
  | "closeout"

/** Mutable per-turn recovery counters, threaded so the budgets are SAME-TURN
 *  (a fresh turn resets them; same-turn retries decrement the shared budget). */
export interface RecoveryState {
  streamRetries: number
  outputContinues: number
  malformedRetries: number
  consecutiveEmpties: number
}

export const freshRecovery = (): RecoveryState => ({
  streamRetries: 0,
  outputContinues: 0,
  malformedRetries: 0,
  consecutiveEmpties: 0,
})

/** What the turn driver should do next. `retry_*` re-enters the SAME turn
 *  (no turn increment); `nudge` first appends a meta user message; `compact`
 *  asks for reactive compaction; `backoff` sleeps `delayMs` first.
 *
 *  `refusal` is a TERMINAL distinct-from-error outcome (ADR-0076 Gap-1 SOTA++):
 *  the model returned `stop_reason="refusal"` — the assistant message carries
 *  the refusal rationale (visible text), so the loop surfaces it as a typed
 *  outcome rather than collapsing into a generic `error`. Same-turn budgets
 *  are NOT consumed (terminal, no retry). */
export type RecoveryAction =
  | { do: "backoff"; attempt: number }
  | { do: "compact" }
  | { do: "nudge"; keepMessage: boolean; text: string; reason: RecoveryReason }
  | { do: "proceed" }
  | { do: "completed" }
  | { do: "refusal"; rationale: string }
  | { do: "error"; reason: string }

/** True when the assembled turn produced nothing usable: no text, no tool_use
 *  (e.g. an empty completion or a thinking-only block). */
export const isEmptyTurn = (m: AssembledMessage): boolean =>
  !m.content.some((b) => (b.type === "text" && b.text.trim() !== "") || b.type === "tool_use")

/** Extract the model's VISIBLE refusal rationale from an assembled assistant
 *  message (ADR-0076 Gap-1 SOTA++). Concatenates only `text` blocks joined by
 *  a blank line. `thinking` / `redacted_thinking` are NOT exposed (those are
 *  the model's private reasoning, not its SAY), and `tool_use` blocks are
 *  ignored — a refusal that emits tool_use is a model bug, but the rationale
 *  text must still surface for the operator. Whitespace-only output trims to
 *  "" so a "refusal with no text" reads as empty rather than as blanks. The
 *  full string is preserved verbatim (no truncation, no escape); callers that
 *  need a short surface form must clip themselves. */
export const extractRefusalRationale = (m: AssembledMessage): string => {
  const parts: string[] = []
  for (const b of m.content) {
    if (b.type === "text") parts.push(b.text)
  }
  return parts.join("\n\n").trim()
}

/** Pure policy for a thrown stream error: classify it, consult the SAME-TURN
 *  budget, and decide. Mutates `rec` (consumes a retry slot) only when it
 *  actually elects to retry — kept here so the decision is unit-testable. */
export const decideOnStreamError = (
  error: unknown,
  message: string,
  rec: RecoveryState,
): RecoveryAction => {
  const kind = classifyLLMError(error)
  if (kind === "retryable") {
    if (rec.streamRetries >= MAX_TURN_STREAM_RETRIES) {
      return { do: "error", reason: `LLM stream failed after retries: ${message}` }
    }
    const attempt = rec.streamRetries
    rec.streamRetries += 1
    return { do: "backoff", attempt }
  }
  if (kind === "prompt_too_long") return { do: "compact" }
  return { do: "error", reason: message }
}

/** Pure policy for a successfully assembled turn: decide whether it is final,
 *  needs a SAME-TURN nudge+retry (output-limit / malformed / empty), or should
 *  proceed to tool dispatch. Mutates `rec` only when it elects a nudge/retry. */
export const decideOnAssembled = (
  stopReason: string,
  message: AssembledMessage,
  rec: RecoveryState,
): RecoveryAction => {
  // ADR-0076 Gap-1 SOTA++: provider refusal / abnormal non-tool stop. The
  // model stopped with an explicit refusal (Anthropic `refusal`, OpenAI
  // content-policy stop). Surface as a typed `refusal` action with the
  // visible-text rationale extracted from the assistant message — the loop
  // routes this to a `refusal` StopReason + `AgentOutcome.refusal{rationale}`
  // instead of collapsing into a generic `error`. Terminal: same-turn budgets
  // are NOT consumed (no retry slot, no nudge — the refusal IS the turn).
  // `pause_turn` (server-tool resume) is intentionally NOT handled: we ship
  // no server-side tools, so it cannot be emitted.
  if (stopReason === "refusal") {
    return { do: "refusal", rationale: extractRefusalRationale(message) }
  }
  if (stopReason === "max_tokens" && rec.outputContinues < MAX_OUTPUT_CONTINUES) {
    rec.outputContinues += 1
    return {
      do: "nudge",
      keepMessage: true,
      text: "Output limit hit — continue exactly where you left off, do not repeat.",
      reason: "nudge",
    }
  }
  const hasTools = message.content.some((b) => b.type === "tool_use")
  if (stopReason === "tool_use" && !hasTools) {
    if (rec.malformedRetries < MAX_MALFORMED_RETRIES) {
      rec.malformedRetries += 1
      return {
        do: "nudge",
        keepMessage: true,
        text:
          "Your previous tool call was malformed/incomplete. Re-issue it as a " +
          "single valid tool call.",
        reason: "malformed",
      }
    }
    return { do: "completed" }
  }
  if (!hasTools && isEmptyTurn(message)) {
    if (rec.consecutiveEmpties >= MAX_CONSECUTIVE_EMPTIES) return { do: "completed" }
    rec.consecutiveEmpties += 1
    return {
      do: "nudge",
      keepMessage: true,
      text: "You returned an empty response. Continue the task or give your final answer.",
      reason: "empty",
    }
  }
  rec.consecutiveEmpties = 0
  return { do: "proceed" }
}
