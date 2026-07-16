import { type assembleFromEvents, createDefaultRecoveryRouter, isRefusalStopReason } from "@/llm"
import { LLMError } from "@/shared"
import { DEFAULT_REFUSAL_FALLBACK_PROMPT } from "./refusal-fallback"
import { classifyLLMError, isPromptTooLong } from "./retry"
import type { StopAction, StopReasonPolicy } from "./stop-reason"
import type { TurnState } from "./turn-context"
import type { AgentConfig } from "./types"

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
const defaultRecoveryRouter = createDefaultRecoveryRouter()

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

/** Loop-control fix (jul-3): reason tag prefixed onto the `error`-class terminal
 *  minted when the model returned only empty turns for the whole same-turn
 *  empty-retry budget (`consecutiveEmpties >= MAX_CONSECUTIVE_EMPTIES`). Sealing
 *  this as `completed` (success) misclassifies a model that produced NOTHING
 *  usable as a clean finish — a repeated empty completion is a NON-success stall,
 *  mirroring the malformed-tool-use seal. Routed to a NON-success `error`-class
 *  terminal so `classifyErrorReason` buckets it (`MODEL_EMPTY_EXHAUSTED`) and the
 *  subagent runner's `ok:reason==="completed"` map flips a stalled child to
 *  `ok:false`. `classifyErrorReason` recognises the `[empty-turn]` prefix. */
export const EMPTY_TURN_EXHAUSTED_REASON =
  "[empty-turn] model returned only empty responses after the same-turn empty-retry budget"

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

/**
 * T08 — refusal-fallback decision inputs threaded into {@link resolveTurnAction}.
 * Kept as a tiny plain struct (no `AgentConfig` / `TurnState`) so the decision
 * stays a PURE, unit-testable function. `budgetOk` is a thunk so the (possibly
 * `taskBudget`-derived) check is evaluated only on a refusal-class stop.
 */
export interface RefusalFallbackInput {
  readonly enabled: boolean
  readonly prompt: string
  readonly budgetOk: () => boolean
}

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

/** Build the refusal-fallback input from config + live turn state, or
 *  `undefined` when the feature is OFF (so {@link resolveTurnAction} is
 *  byte-identical). Pure aside from reading the (already-accumulated) spend. */
export const buildRefusalFallbackInput = (
  config: AgentConfig,
  state: TurnState,
): RefusalFallbackInput | undefined => {
  const cfg = config.refusalFallback
  if (cfg === undefined || cfg.enabled !== true) return undefined
  return {
    enabled: true,
    prompt: cfg.prompt ?? DEFAULT_REFUSAL_FALLBACK_PROMPT,
    budgetOk: () => refusalForkBudgetOk(config, state),
  }
}

/** A refusal fork roughly DOUBLES the turn's token cost (re-prompt + re-stream).
 *  Gate it on the SOFT task budget: when a finite, positive `taskBudget` is set
 *  and the cumulative spend has already reached it, decline the fork (terminal).
 *  No `taskBudget` (or non-positive) ⇒ no ceiling to exceed ⇒ allowed. The
 *  boundary is the budget itself — NOT an arbitrary fraction
 *  ([[no-heuristics-only-validated]]). */
const refusalForkBudgetOk = (config: AgentConfig, state: TurnState): boolean => {
  const tb = config.taskBudget
  if (tb === undefined || !Number.isFinite(tb.tokens) || tb.tokens <= 0) return true
  const spent = state.taskSpend?.tokens ?? tb.spent ?? 0
  return spent < tb.tokens
}

/** Pure policy for a thrown stream error: classify it, consult the SAME-TURN
 *  budget, and decide. Mutates `rec` (consumes a retry slot) only when it
 *  actually elects to retry — kept here so the decision is unit-testable. */
export const decideOnStreamError = (
  error: unknown,
  message: string,
  rec: RecoveryState,
): RecoveryAction => {
  const typed = decideTypedStreamError(error, message, rec)
  if (typed !== undefined) return typed
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

/**
 * The outer turn-recovery owner consumes the Codex typed router. `RetryingLLM`
 * remains a separate decorator policy for pre-stream transport retries. A
 * fallback-class error reaches here only after any `FallbackLLM` chain has
 * exhausted its own provider-selection attempt, so the outer owner preserves
 * the bounded retry budget instead of inventing a provider-selection shim.
 */
const decideTypedStreamError = (
  error: unknown,
  message: string,
  rec: RecoveryState,
): RecoveryAction | undefined => {
  if (!(error instanceof LLMError) || error.kind === "unknown") return undefined
  // Preserve the existing provider-message PTL signal: many adapters can only
  // classify the HTTP status as bad_request even though the body names overflow.
  if (isPromptTooLong(error)) return { do: "compact" }
  switch (defaultRecoveryRouter.route(error.kind)) {
    case "reactive_compaction":
      return { do: "compact" }
    case "hitl_handoff":
      return { do: "error", reason: `LLM requires operator intervention: ${message}` }
    case "fatal":
      return { do: "error", reason: message }
    case "retry_after_backoff":
    case "fallback_provider":
    case "retry_same_turn": {
      if (rec.streamRetries >= MAX_TURN_STREAM_RETRIES)
        return { do: "error", reason: `LLM stream failed after retries: ${message}` }
      const attempt = rec.streamRetries
      rec.streamRetries += 1
      return { do: "backoff", attempt }
    }
  }
}

/** Pure policy for a successfully assembled turn: decide whether it is final,
 *  needs a SAME-TURN nudge+retry (output-limit / malformed / empty), or should
 *  proceed to tool dispatch. Mutates `rec` only when it elects a nudge/retry. */
// ── Per-case recovery deciders (assembled turn) ──────────────────────────────
// Each maps ONE terminal-shape to a {@link RecoveryAction}, or `null` to defer to
// the next case. Extracted from the former inline `decideOnAssembled` switch so a
// new recovery case is a discrete, unit-testable function + one orchestrator line
// — NOT a deeper `if`-ladder. Order + the two fallthrough side effects
// (max_tokens truncation marker, empty-streak reset) stay in the orchestrator
// because they run on the NON-returning path, so byte-identical behavior is kept.

/** ADR-0076 Gap-1: provider refusal / content-policy stop → typed `refusal`
 *  (visible-text rationale). Terminal — same-turn budgets are NOT consumed. */
const decideRefusal = (stopReason: string, message: AssembledMessage): RecoveryAction | null =>
  isRefusalStopReason(stopReason)
    ? { do: "refusal", rationale: extractRefusalRationale(message) }
    : null

/** `max_tokens` truncation with continuation budget remaining → a "continue where
 *  you left off" nudge (consumes one continuation slot). `null` when not
 *  `max_tokens` OR the budget is spent (the orchestrator then marks + seals). */
const decideMaxTokensNudge = (stopReason: string, rec: RecoveryState): RecoveryAction | null => {
  if (stopReason !== "max_tokens" || rec.outputContinues >= MAX_OUTPUT_CONTINUES) return null
  rec.outputContinues += 1
  return {
    do: "nudge",
    keepMessage: true,
    text: "Output limit hit — continue exactly where you left off, do not repeat.",
    reason: "nudge",
  }
}

/** `stop_reason:"tool_use"` but NO valid tool_use block assembled → a "re-issue the
 *  tool call" nudge while the malformed budget lasts, else a DISTINCT non-success
 *  `error` terminal (a fumbled tool call must not read as `completed`). */
const decideMalformed = (
  stopReason: string,
  hasTools: boolean,
  rec: RecoveryState,
): RecoveryAction | null => {
  if (stopReason !== "tool_use" || hasTools) return null
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
  return { do: "error", reason: MALFORMED_TOOL_USE_REASON }
}

/** A no-tool empty turn → an "empty response" nudge while the empty-streak budget
 *  lasts, else a DISTINCT non-success `error` terminal (a produced-NOTHING stall
 *  must not read as `completed`). Consumes/extends the streak counter. */
const decideEmpty = (
  message: AssembledMessage,
  hasTools: boolean,
  rec: RecoveryState,
): RecoveryAction | null => {
  if (hasTools || !isEmptyTurn(message)) return null
  if (rec.consecutiveEmpties >= MAX_CONSECUTIVE_EMPTIES)
    return { do: "error", reason: EMPTY_TURN_EXHAUSTED_REASON }
  rec.consecutiveEmpties += 1
  return {
    do: "nudge",
    keepMessage: true,
    text: "You returned an empty response. Continue the task or give your final answer.",
    reason: "empty",
  }
}

export const decideOnAssembled = (
  stopReason: string,
  message: AssembledMessage,
  rec: RecoveryState,
): RecoveryAction => {
  const refusal = decideRefusal(stopReason, message)
  if (refusal) return refusal
  const maxTokensNudge = decideMaxTokensNudge(stopReason, rec)
  if (maxTokensNudge) return maxTokensNudge
  // Reaching here on `max_tokens` means the continuation budget is SPENT: append a
  // visible (idempotent) truncation marker so a mid-sentence answer doesn't seal as
  // a clean `completed` — the turn still seals via the text-completion path below.
  if (stopReason === "max_tokens") markTruncatedOutput(message)
  const hasTools = message.content.some((b) => b.type === "tool_use")
  const malformed = decideMalformed(stopReason, hasTools, rec)
  if (malformed) return malformed
  const empty = decideEmpty(message, hasTools, rec)
  if (empty) return empty
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

export const resolveTurnAction = (
  policy: StopReasonPolicy | undefined,
  result: { error: unknown; message: string } | { stopReason: string; message: AssembledMessage },
  rec: RecoveryState,
  refusal?: RefusalFallbackInput,
): RecoveryAction => {
  if ("error" in result) return decideOnStreamError(result.error, result.message, rec)
  const stop = result.stopReason
  // T08 — refusal-fallback recovery. Provider-blind: the `isRefusalStopReason`
  // seam folds Anthropic `refusal` and OpenAI `content_filtered` onto one check,
  // so this branch is identical for both vendors. Checked BEFORE the legacy
  // mapping so a recovered/exhausted refusal never runs `decideOnAssembled`'s
  // mutating empty/nudge accounting (which would corrupt same-turn budgets).
  //
  // GUARD — only recover a CLEAN, text-only refusal. A refusal-class stop that
  // ALSO carried a `tool_use` block: `streamingTurn` short-circuits Phase-3
  // deferred (barrier-blocked, MUTATING) dispatch for BOTH `refusal` AND
  // `content_filtered` (ALBB-03 — both route through `isRefusalStopReason`), so
  // no deferred mutating tool runs on a refusal-class turn. But an overlap-safe
  // (read-only, concurrency-safe) call may have pre-started in Phase 1 and
  // cannot be un-started; neutralizing such a turn would discard those
  // executed-tool results AND risk a re-execution on the re-prompt (double
  // side effect). So a tool-carrying refusal falls through to the legacy
  // mapping, which is now TERMINAL for both `refusal` and `content_filtered`
  // (`decideRefusal` folds them via `isRefusalStopReason`) — no silent proceed.
  if (
    refusal?.enabled === true &&
    isRefusalStopReason(stop) &&
    !result.message.content.some((b) => b.type === "tool_use")
  ) {
    if (rec.refusalFallbacks < RECOVERY_CAPS.refusalFallbacks && refusal.budgetOk()) {
      rec.refusalFallbacks += 1
      return { do: "refusal_fallback", text: refusal.prompt, message: result.message }
    }
    // One-shot spent OR a fork would exceed budget ⇒ TERMINAL refusal. Surfaced
    // as `refusal` (not a generic error) for BOTH providers so a re-refusal —
    // including `content_filtered` (the legacy `decideOnAssembled` mapping is
    // now ALSO terminal for it via `decideRefusal`/`isRefusalStopReason`, ALBB-03)
    // — never silently completes and reads consistently to the host.
    return { do: "refusal", rationale: extractRefusalRationale(result.message) }
  }
  // OFF / non-refusal / tool-carrying refusal ⇒ legacy mapping verbatim
  // (byte-identical default).
  return decideFromStopPolicy(policy, stop) ?? decideOnAssembled(stop, result.message, rec)
}
