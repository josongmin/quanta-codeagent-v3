/**
 * StopCategory matrix — Cursor agent stop_category absorption (Spec B3).
 *
 * The legacy {@link StopReason} (`completed | max_turns | aborted | error`)
 * is a four-element enum that cannot say WHY the agent stopped beyond
 * "exhausted" / "errored" / "aborted". A surface that needs to render
 * actionable copy ("you hit the rate limit, retry in a moment" vs. "the
 * agent paused for approval" vs. "the user pressed Esc") had to re-classify
 * by sniffing emitted `error`/`recovery` events — fragile and out of band.
 *
 * Cursor's `stop_category` is a STRUCTURED reason with three layers:
 *   1. `kind` — coarse bucket (completed/interrupted/failed/...) suitable
 *      for UI gating;
 *   2. `reasonCode` — stable, namespaced code (`provider.rate_limit`,
 *      `user.interrupt`, `shell.needs_approval`) for analytics + i18n;
 *   3. `hint` — optional human-readable copy a surface can render verbatim
 *      when it has nothing better.
 *
 * This module defines that structure as a PURE, optional add-on to
 * {@link AgentOutcome}. The legacy `reason: StopReason` field stays the
 * authoritative top-level outcome (every shipped consumer reads it); the
 * new `stopCategory?` field is OPTIONAL on the outcome, so absent callers
 * see byte-identical behavior (RFC §1.2). Adding a new code MUST extend the
 * documented enums in this file — never raw strings at the call site.
 */

/**
 * Coarse bucket — what the surface needs to switch on for top-level UI
 * gating. Keep this set CLOSED (extending it is a typed change that flushes
 * out every consumer). Mapping to the legacy {@link StopReason}:
 *
 *   - `completed`              ⇄ legacy `completed`
 *   - `max_turns`              ⇄ legacy `max_turns`
 *   - `interrupted`            ⇄ legacy `aborted` (user/system interrupt)
 *   - `failed`                 ⇄ legacy `error` (provider/runtime failure)
 *   - `needs_user_approval`    ⇄ legacy `error` (hand-off-required deny that
 *                                surfaces want as a distinct UX, not a hard
 *                                failure). NOT wired by default; reserved
 *                                for the admissibility-gate seam.
 */
export type StopCategoryKind =
  | "completed"
  | "max_turns"
  | "interrupted"
  | "failed"
  | "needs_user_approval"
  | "refusal" /* ADR-0076 Gap-1 SOTA++ — model declined via
                 `stop_reason="refusal"`. Distinct from `failed` (the model
                 worked correctly — it chose to refuse) and from `completed`
                 (the task was NOT completed). */

/**
 * Structured stop category.
 *
 *   - `kind` — coarse bucket, see {@link StopCategoryKind}.
 *   - `reasonCode` — stable namespaced code. Canonical codes (extend the
 *     {@link STOP_REASON_CODE} table below — never inline a literal):
 *       provider.rate_limit, provider.overloaded, provider.network,
 *       provider.auth, provider.bad_request, provider.unknown,
 *       compaction.thrash, user.interrupt, system.abort, shell.needs_approval,
 *       runtime.unknown_error, completed.normal, completed.max_turns,
 *       completed.empty_exhausted, completed.malformed_exhausted.
 *   - `hint` — optional surface-facing copy, never used for control flow.
 */
export interface StopCategory {
  kind: StopCategoryKind
  reasonCode: string
  hint?: string
}

/**
 * Canonical reason codes (the only strings call sites should write). Adding
 * a new bucket here is the ONLY supported way to extend the matrix — keeps
 * `reasonCode` analytics-stable and lets a grep over the codebase enumerate
 * every site that emits one.
 */
export const STOP_REASON_CODE = {
  /** Provider returned 429 — same-turn retry budget exhausted. */
  PROVIDER_RATE_LIMIT: "provider.rate_limit",
  /** Provider returned 529 / overloaded_error after retries. */
  PROVIDER_OVERLOADED: "provider.overloaded",
  /** Network / transport failure (ECONNRESET, EPIPE, ETIMEDOUT). */
  PROVIDER_NETWORK: "provider.network",
  /** Provider returned 401/403 — caller credential failure. */
  PROVIDER_AUTH: "provider.auth",
  /** Provider returned 400/422 — caller bug (malformed request). */
  PROVIDER_BAD_REQUEST: "provider.bad_request",
  /** Provider error with no structured signal (stream_corrupt / unknown). */
  PROVIDER_UNKNOWN: "provider.unknown",
  /** Compaction breaker tripped (compact↔PTL thrash). */
  COMPACTION_THRASH: "compaction.thrash",
  /** User pressed the interrupt key (Ctrl+C / Esc → AbortSignal). */
  USER_INTERRUPT: "user.interrupt",
  /** System-issued abort (host shutdown / parent process). */
  SYSTEM_ABORT: "system.abort",
  /** Admissibility-gate hand-off-required: tool needs explicit user
   *  approval. Reserved for the gate seam (not wired in this round). */
  SHELL_NEEDS_APPROVAL: "shell.needs_approval",
  /** Runtime exception not classified as an LLM error. */
  RUNTIME_UNKNOWN_ERROR: "runtime.unknown_error",
  /** Normal completion — model produced a final assistant turn with no
   *  tool_use blocks. */
  COMPLETED_NORMAL: "completed.normal",
  /** Loop hit `maxTurns` cap. */
  COMPLETED_MAX_TURNS: "completed.max_turns",
  /** Same-turn empty-retry budget exhausted. */
  COMPLETED_EMPTY_EXHAUSTED: "completed.empty_exhausted",
  /** Same-turn malformed-tool retry budget exhausted. */
  COMPLETED_MALFORMED_EXHAUSTED: "completed.malformed_exhausted",
  /** Model returned `stop_reason="refusal"` (Anthropic refusal / OpenAI
   *  content-policy stop). The visible-text rationale is surfaced on
   *  `AgentOutcome.refusal.rationale`. */
  MODEL_REFUSAL: "model.refusal",
  /** Loop-control fix (jun-25): the model signalled `stop_reason="tool_use"`
   *  but never emitted a valid tool_use block, and the same-turn malformed
   *  retry budget was spent. A FUMBLED tool call — NON-success (the model
   *  intended to act and could not), distinct from a clean completion. */
  MODEL_MALFORMED_TOOL_USE: "model.malformed_tool_use",
} as const

export type StopReasonCode = (typeof STOP_REASON_CODE)[keyof typeof STOP_REASON_CODE]

/**
 * Classify a legacy `error` outcome's free-form reason text into a typed
 * {@link StopCategory}. NEVER throws — if no signal can be pulled out, falls
 * back to `{ kind:"failed", reasonCode: runtime.unknown_error }`.
 *
 * Pure (no IO, no clock). Tests live in `tests/unit/stop-category.test.ts`.
 *
 * Heuristics — ordered by specificity:
 *   1. compaction-breaker thrash message — distinct prefix.
 *   2. provider.*: matched via the `LLMErrorKind` discriminator (the seam in
 *      loop.ts already classifies and stringifies, so we read the
 *      stringified form back — this is the ONLY string-sniff site in the
 *      codebase per the errors.ts contract, and it is opt-in additive).
 *   3. anything else → `runtime.unknown_error`.
 */
export const classifyErrorReason = (reason: string): StopCategory => {
  // Compaction-breaker tripped (see compaction-breaker.ts: emits a verdict
  // text starting with "compaction").
  if (/compaction/i.test(reason) && /(thrash|no.progress|breaker)/i.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.COMPACTION_THRASH,
      hint: "Compaction made no progress; aborted to avoid a spin.",
    }
  }
  // Loop-control fix (jun-25): fumbled tool call. The malformed-tool-use
  // terminal (recovery.ts MALFORMED_TOOL_USE_REASON) is tagged with a fixed
  // `[malformed-tool-use]` prefix so a host can render "the model tried to act
  // but couldn't" distinctly from a provider/runtime failure. Checked BEFORE
  // the provider patterns (its prefix is unambiguous).
  if (/^\[malformed-tool-use\]/.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.MODEL_MALFORMED_TOOL_USE,
      hint: "Model signalled a tool call but could not emit a valid one.",
    }
  }
  // Provider-classified failures. The loop stringifies the LLMError; the
  // adapter prefixes either `<provider> request failed:` or includes the
  // message of an `LLMError.kind`. We pattern-match the message text the
  // shared errors module produces — covered by tests, NOT brittle (the
  // strings are fixed by the contract in errors.ts).
  if (/rate.?limit|status.?429/i.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.PROVIDER_RATE_LIMIT,
      hint: "Provider rate limit exceeded.",
    }
  }
  if (/overload|status.?529/i.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.PROVIDER_OVERLOADED,
      hint: "Provider is overloaded.",
    }
  }
  if (/ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|network/i.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.PROVIDER_NETWORK,
      hint: "Network transport failure.",
    }
  }
  if (/status.?40[13]|unauthor|forbidden/i.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.PROVIDER_AUTH,
      hint: "Provider credentials rejected.",
    }
  }
  if (/status.?(400|422)|bad.request/i.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.PROVIDER_BAD_REQUEST,
      hint: "Provider rejected the request shape.",
    }
  }
  if (/LLM stream failed|llm request failed|provider/i.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.PROVIDER_UNKNOWN,
    }
  }
  return {
    kind: "failed",
    reasonCode: STOP_REASON_CODE.RUNTIME_UNKNOWN_ERROR,
  }
}

/** Stop category for the normal-completion path. `via` distinguishes the
 *  three completion sub-types the loop already discriminates internally
 *  (proceed-no-tools, malformed-exhausted, empty-exhausted) so a surface
 *  can render a hint that matches what actually happened. */
export const completedCategory = (
  via: "normal" | "max_turns" | "empty_exhausted" | "malformed_exhausted" = "normal",
): StopCategory => {
  switch (via) {
    case "max_turns":
      return {
        kind: "max_turns",
        reasonCode: STOP_REASON_CODE.COMPLETED_MAX_TURNS,
        hint: "Reached the configured maxTurns limit.",
      }
    case "empty_exhausted":
      return {
        kind: "completed",
        reasonCode: STOP_REASON_CODE.COMPLETED_EMPTY_EXHAUSTED,
        hint: "Stopped after repeated empty model responses.",
      }
    case "malformed_exhausted":
      return {
        kind: "completed",
        reasonCode: STOP_REASON_CODE.COMPLETED_MALFORMED_EXHAUSTED,
        hint: "Stopped after repeated malformed tool calls.",
      }
    default:
      return { kind: "completed", reasonCode: STOP_REASON_CODE.COMPLETED_NORMAL }
  }
}

/** Stop category for the aborted path. `cause:"user"` ⇄ `user.interrupt`,
 *  `cause:"system"` ⇄ `system.abort`. The default matches the most common
 *  source (user hit Ctrl+C / Esc → AbortSignal). */
export const interruptedCategory = (cause: "user" | "system" = "user"): StopCategory => ({
  kind: "interrupted",
  reasonCode: cause === "user" ? STOP_REASON_CODE.USER_INTERRUPT : STOP_REASON_CODE.SYSTEM_ABORT,
  hint: cause === "user" ? "User interrupt." : "Run aborted by host.",
})

/** Stop category for the refusal path (ADR-0076 Gap-1 SOTA++). The host can
 *  pull the rationale from `AgentOutcome.refusal.rationale`; this category
 *  is the analytics-stable signal that "the model declined" (distinct from
 *  any provider/runtime `failed` bucket). */
export const refusalCategory = (): StopCategory => ({
  kind: "refusal",
  reasonCode: STOP_REASON_CODE.MODEL_REFUSAL,
  hint: "Model declined to continue.",
})
