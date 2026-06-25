import type { assembleFromEvents } from "@/llm"
import { classifyLLMError } from "./retry"
import type { StopAction, StopReasonPolicy } from "./stop-reason"

/** Bounded per-turn recovery budgets. These cap SAME-TURN retries so a
 *  pathological provider can never spin the loop forever; once exhausted the
 *  loop degrades gracefully (finish / accept-partial) rather than hanging. */
const MAX_TURN_STREAM_RETRIES = 3
const MAX_OUTPUT_CONTINUES = 3
const MAX_MALFORMED_RETRIES = 1
const MAX_CONSECUTIVE_EMPTIES = 2
/** T08 — model-refusal recovery is ONE-SHOT. This is a HARD rule, NOT a tunable
 *  knob: re-prompting more than once on repeated refusals risks an infinite
 *  refusal loop and pressures the model past real safety boundaries, and `n>1`
 *  is forbidden without measurement ([[no-heuristics-only-validated]]). */
const MAX_REFUSAL_FALLBACKS = 1

/** Per-kind same-turn recovery budget caps (ADR documented in this module
 *  header + the conversation_action_noop branch of loop.ts). Frozen so a test
 *  asserting a cap mutates with the source rather than carrying duplicated
 *  magic numbers. */
export const RECOVERY_CAPS = Object.freeze({
  streamRetries: MAX_TURN_STREAM_RETRIES,
  outputContinues: MAX_OUTPUT_CONTINUES,
  malformedRetries: MAX_MALFORMED_RETRIES,
  consecutiveEmpties: MAX_CONSECUTIVE_EMPTIES,
  refusalFallbacks: MAX_REFUSAL_FALLBACKS,
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

/** Loop-control fix (jun-25): visible marker appended to the surfaced text when
 *  a turn is sealed while STILL `max_tokens`-truncated after the continuation
 *  budget is spent. Without it a mid-sentence answer reads as a clean
 *  completion; with it the operator + downstream classifier can tell the output
 *  was CUT, not cleanly finished. Exported so tests pin the exact literal. */
export const OUTPUT_TRUNCATED_MARKER = "\n\n[output truncated at token budget]"

/** Loop-control fix (jun-25): reason tag prefixed onto the `error`-class
 *  terminal minted when the model signalled `tool_use` intent but could not
 *  emit a valid tool call within the malformed-retry budget. Routed to a
 *  NON-success outcome (NOT `completed`) so a fumbled tool call is never
 *  misclassified as success. `classifyErrorReason` recognises this prefix. */
export const MALFORMED_TOOL_USE_REASON =
  "[malformed-tool-use] model signalled a tool call but could not emit a valid one after retries"

/** Mutable per-turn recovery counters, threaded so the budgets are SAME-TURN
 *  (a fresh turn resets them; same-turn retries decrement the shared budget). */
export interface RecoveryState {
  streamRetries: number
  outputContinues: number
  malformedRetries: number
  consecutiveEmpties: number
  /** T08 — count of refusal-fallback re-prompts spent THIS turn (cap
   *  {@link RECOVERY_CAPS.refusalFallbacks}). A fresh turn resets it. */
  refusalFallbacks: number
}

export const freshRecovery = (): RecoveryState => ({
  streamRetries: 0,
  outputContinues: 0,
  malformedRetries: 0,
  consecutiveEmpties: 0,
  refusalFallbacks: 0,
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
  | { do: "refusal_fallback"; text: string; message: AssembledMessage }
  | { do: "error"; reason: string }

/** Loop-control fix (jun-25): append {@link OUTPUT_TRUNCATED_MARKER} to the
 *  message's surfaced text in place, so a `max_tokens`-truncated turn sealed
 *  after the continuation budget reads as CUT, not cleanly finished. Mutates the
 *  LAST text block (the tail the user sees) or pushes a fresh text block when
 *  the truncated turn carried no text at all (e.g. thinking-only). Idempotent:
 *  a message already bearing the marker is left untouched, so re-entry (guards
 *  / re-decide on the same assembled message) never doubles it. */
export const markTruncatedOutput = (m: AssembledMessage): void => {
  const lastText = [...m.content].reverse().find((b) => b.type === "text")
  if (lastText !== undefined && lastText.type === "text") {
    if (lastText.text.endsWith(OUTPUT_TRUNCATED_MARKER)) return
    lastText.text += OUTPUT_TRUNCATED_MARKER
    return
  }
  m.content.push({ type: "text", text: OUTPUT_TRUNCATED_MARKER.trimStart() })
}

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

/** T08 — harness-authored marker that REPLACES a refused assistant turn when
 *  the refusal-fallback recovery forks it off. It is DATA, never the model's
 *  withheld SAY. Kept terse + neutral so the single retry does not re-anchor on
 *  the prior refusal. */
export const REFUSAL_NEUTRALIZED_MARKER =
  "(Previous response was withheld and neutralized for a single automatic retry.)"

/** Build the neutralized assistant turn that stands in for a refused turn (T08
 *  fork/neutralize). We keep an ASSISTANT message — not a drop — so provider
 *  role-alternation holds (both Anthropic and OpenAI reject two consecutive
 *  user turns, which a bare drop-then-reprompt would create), but its content is
 *  ONLY the neutral marker: the refusal text never enters the durable transcript
 *  nor the retry's context. Pure; allocates one message. */
export const neutralizedRefusalTurn = (): AssembledMessage => ({
  role: "assistant",
  content: [{ type: "text", text: REFUSAL_NEUTRALIZED_MARKER }],
})

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
  if (stopReason === "max_tokens") {
    if (rec.outputContinues < MAX_OUTPUT_CONTINUES) {
      rec.outputContinues += 1
      return {
        do: "nudge",
        keepMessage: true,
        text: "Output limit hit — continue exactly where you left off, do not repeat.",
        reason: "nudge",
      }
    }
    // Loop-control fix (jun-25): the continuation budget is spent and the turn
    // is STILL `max_tokens`-truncated. The text that follows would otherwise
    // be sealed as a clean `completed`, making a mid-sentence answer read as a
    // finished one. Append a VISIBLE truncation marker to the surfaced text
    // (idempotent — never doubled) so downstream + the user can tell the output
    // was cut. We do NOT change the stop itself; the turn still seals via the
    // text-completion path below.
    markTruncatedOutput(message)
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
    // Loop-control fix (jun-25): the model INTENDED to act (`stop_reason
    // ="tool_use"`) but never assembled a valid tool_use block, and the
    // same-turn malformed-retry budget is spent. Sealing this as `completed`
    // (success) misclassifies a fumbled tool call. Seal as a DISTINCT
    // NON-SUCCESS `error`-class terminal — the outer resolver maps `error`
    // → reason `"error"` and `classifyErrorReason` buckets the tagged reason,
    // mirroring every other non-success terminal.
    return { do: "error", reason: MALFORMED_TOOL_USE_REASON }
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

/** ADR-0242 — Consult a {@link StopReasonPolicy} and translate its decision
 *  into a terminal {@link RecoveryAction}, or `null` to fall through to the
 *  legacy {@link decideOnAssembled} mapping.
 *
 *  Translation table (closed; one arm per StopAction):
 *    `continue` → `null` (fall through; legacy mapping retains final word).
 *    `surface`  → `{ do: "error", reason }` (legacy-shaped terminal).
 *    `abort`    → `{ do: "error", reason: "[stop-abort] " + reason }` (tagged).
 *    `hitl`     → `{ do: "error", reason: "[stop-hitl] " + reason }` (tagged).
 *
 *  Pure. Does NOT consume any same-turn recovery budget (the policy decides
 *  the turn is terminal — no retry, no budget bookkeeping). The tags are
 *  prefixed onto `reason` so observability + a future HITL re-router can
 *  recognise them by substring without changing this surface.
 *
 *  When `policy` is `undefined` returns `null` (byte-identical to the
 *  pre-ADR path). The wire site short-circuits on `policy === undefined`
 *  BEFORE calling this helper for zero allocation; this `undefined` arm is
 *  kept for callers that prefer one branch over two. */
export const decideFromStopPolicy = (
  policy: StopReasonPolicy | undefined,
  stopReason: string,
): RecoveryAction | null => {
  if (policy === undefined) return null
  const action: StopAction = policy.handle(stopReason)
  switch (action.kind) {
    case "continue":
      return null
    case "surface":
      return { do: "error", reason: action.reason }
    case "abort":
      return { do: "error", reason: `[stop-abort] ${action.reason}` }
    case "hitl":
      return { do: "error", reason: `[stop-hitl] ${action.reason}` }
  }
}
