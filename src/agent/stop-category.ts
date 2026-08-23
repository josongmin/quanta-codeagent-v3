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
import type { StopReason } from "@/agent/types/agent-outcome"

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
  | "budget" /* ALBB-17 claim 1 — run stopped by a cost/budget cap (L2 per-run
                cost meter OR L4 cross-run ledger). Distinct from `max_turns`
                (turn-count exhaustion) and `completed` (task done): the run was
                killed for SPEND, so a surface renders a cost-cap hint, not a
                "raise maxTurns" hint. Mirrors Cursor's `budget` stop bucket. */

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
 *       budget.cost_cap, budget.ledger_breach,
 *       model.empty_exhausted, model.malformed_tool_use.
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
  /** ALBB-17 claim 1 — L2 per-run cost cap tripped: a cost pre-flight (a call
   *  that must breach `maxCostUsd`) OR the post-turn cost meter. */
  BUDGET_COST_CAP: "budget.cost_cap",
  /** ALBB-17 claim 1 — L4 cross-run cost ledger hard breach (session/daily
   *  ceiling crossed). Split from `BUDGET_COST_CAP` so analytics distinguishes
   *  a per-run meter cap from a cross-run ledger cap. */
  BUDGET_LEDGER_BREACH: "budget.ledger_breach",
  /** Model returned `stop_reason="refusal"` (Anthropic refusal / OpenAI
   *  content-policy stop). The visible-text rationale is surfaced on
   *  `AgentOutcome.refusal.rationale`. */
  MODEL_REFUSAL: "model.refusal",
  /** Loop-control fix (jun-25): the model signalled `stop_reason="tool_use"`
   *  but never emitted a valid tool_use block, and the same-turn malformed
   *  retry budget was spent. A FUMBLED tool call — NON-success (the model
   *  intended to act and could not), distinct from a clean completion. */
  MODEL_MALFORMED_TOOL_USE: "model.malformed_tool_use",
  /** Loop-control fix (jul-3): the model returned only empty turns for the whole
   *  same-turn empty-retry budget (`consecutiveEmpties` exhausted). A produced-
   *  NOTHING stall — NON-success (the model never gave text, a tool call, OR a
   *  final answer), distinct from a clean completion. */
  MODEL_EMPTY_EXHAUSTED: "model.empty_exhausted",
  /** aug-23 priority 2 — the dedup gate's opt-in no-progress ceiling tripped:
   *  the model kept re-issuing a call the gate had already blocked. A WEDGE,
   *  distinct from `max_turns` (budget spent doing varied work) and from any
   *  completion. */
  LOOP_NO_PROGRESS: "loop.no_progress",
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
  // Loop-control fix (jul-3): empty-turn exhaustion. The empty-exhausted terminal
  // (recovery.ts EMPTY_TURN_EXHAUSTED_REASON) carries a fixed `[empty-turn]`
  // prefix so a host renders "the model stalled producing nothing" distinctly
  // from a provider/runtime failure. Checked BEFORE the provider patterns (its
  // prefix is unambiguous), same as the malformed arm above.
  if (/^\[empty-turn\]/.test(reason)) {
    return {
      kind: "failed",
      reasonCode: STOP_REASON_CODE.MODEL_EMPTY_EXHAUSTED,
      hint: "Model returned only empty responses; stopped after the retry budget.",
    }
  }
  // ALBB-17 claim 3 — stop-reason-policy terminals. `decideFromStopPolicy`
  // (recovery.ts) tags a routed `abort` action `[stop-abort] …` and a routed
  // `hitl` action `[stop-hitl] …` (the two terminal arms the default policy can
  // produce: content_filtered→abort, guardrail_intervened→hitl). Without these
  // arms both fell through to `runtime.unknown_error` — mislabelled. Codes
  // already exist (SYSTEM_ABORT / SHELL_NEEDS_APPROVAL); no new enum entries.
  // INERT until `config.stopReasonPolicy` is wired (default-OFF), landed with the
  // policy so the classification is correct the moment it is. Checked BEFORE the
  // provider patterns (unambiguous fixed prefixes, same as the two arms above).
  if (/^\[stop-abort\]/.test(reason)) {
    return {
      kind: "interrupted",
      reasonCode: STOP_REASON_CODE.SYSTEM_ABORT,
      hint: "Stop-reason policy aborted the run (e.g. provider content filter).",
    }
  }
  if (/^\[stop-hitl\]/.test(reason)) {
    return {
      kind: "needs_user_approval",
      reasonCode: STOP_REASON_CODE.SHELL_NEEDS_APPROVAL,
      hint: "Stop-reason policy escalated to a human (guardrail intervened).",
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

/** Stop category for the normal-completion path. `via` distinguishes the two
 *  LIVE completion sub-types the loop discriminates (proceed-no-tools clean
 *  completion vs. the maxTurns cap) so a surface can render a matching hint.
 *
 *  ALBB-17 claim 4: the `"empty_exhausted"` / `"malformed_exhausted"` arms were
 *  removed — they had ZERO production callers (production routes empty/malformed
 *  exhaustion through the live `model.empty_exhausted` / `model.malformed_tool_use`
 *  codes via {@link classifyErrorReason}). Reintroducing an arm here without a
 *  production caller fails typecheck at the call site (closed union) + the
 *  taxonomy-collapse guard test. */
export const completedCategory = (via: "normal" | "max_turns" = "normal"): StopCategory => {
  switch (via) {
    case "max_turns":
      return {
        kind: "max_turns",
        reasonCode: STOP_REASON_CODE.COMPLETED_MAX_TURNS,
        hint: "Reached the configured maxTurns limit.",
      }
    default:
      return { kind: "completed", reasonCode: STOP_REASON_CODE.COMPLETED_NORMAL }
  }
}

/** Stop category for a budget/cost-cap stop (ALBB-17 claim 1). `source`
 *  distinguishes the three live cost-cap sites so analytics can tell a per-run
 *  meter cap from a cross-run ledger cap:
 *    - `"preflight"` — L2 pre-model cost admission (`costPreflightCondition`).
 *    - `"meter"`     — L2 post-turn cost meter exhaustion (`turn-outcome`).
 *    - `"ledger"`    — L4 cross-run ledger hard breach (`ledgerHardBreachCondition`).
 *  The meter/preflight sites share `budget.cost_cap` (same per-run meter, one
 *  before vs. after the call); the ledger site gets its own `budget.ledger_breach`.
 *  The hint is a cost-cap message — never the misleading "maxTurns" hint. */
export const budgetCategory = (source: "preflight" | "meter" | "ledger"): StopCategory =>
  source === "ledger"
    ? {
        kind: "budget",
        reasonCode: STOP_REASON_CODE.BUDGET_LEDGER_BREACH,
        hint: "Stopped: cross-run cost ledger budget exhausted.",
      }
    : {
        kind: "budget",
        reasonCode: STOP_REASON_CODE.BUDGET_COST_CAP,
        hint: "Stopped: run cost budget exhausted.",
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

/* ------------------------------------------------------------------------- *
 * StopReason ⇄ StopCategoryKind completeness (aug-23 §13 slice 1a)
 *
 * The audit in `docs/analysis/aug-23-grok-build-review.md` §13 found a producer
 * that emits a terminal outcome with NO category (`approvalPlaceholderOutcome`).
 * A surface that cannot see a category falls back to success copy — the exact
 * competitor bug we are avoiding. This table makes the coverage TYPED: adding a
 * `StopReason` member fails compilation here, and the runtime guard catches a
 * stale or extra key at module load (precedent: `promax/classify.ts`).
 * ------------------------------------------------------------------------- */

/** Coarse bucket for every legacy {@link StopReason}. Exhaustive by type. */
export const STOP_CATEGORY_KIND_BY_STOP_REASON: Record<StopReason, StopCategoryKind> = {
  completed: "completed",
  max_turns: "max_turns",
  aborted: "interrupted",
  error: "failed",
  budget_exhausted: "budget",
  refusal: "refusal",
  /* PAUSED pending a human decision — deliberately NOT `completed`/`failed`:
     the run is resumable, and a surface must render "waiting on you", not a
     success or a hard error. */
  awaiting_approval: "needs_user_approval",
}

/** Every `StopReason`, for the runtime guard. Kept beside the table so the two
 *  drift together or not at all. */
const ALL_STOP_REASONS_RUNTIME: readonly StopReason[] = [
  "completed",
  "max_turns",
  "aborted",
  "error",
  "budget_exhausted",
  "refusal",
  "awaiting_approval",
]

/**
 * Runtime drift guard — throws when the mapping table and the union disagree.
 * Called at module load (below) so a mismatch fails fast rather than silently
 * degrading a surface to success copy. Args are injectable ONLY so the hellgate
 * can prove the guard actually fires (red-on-injection).
 */
export const assertStopReasonTablesInSync = (
  table: Record<string, StopCategoryKind> = STOP_CATEGORY_KIND_BY_STOP_REASON,
  reasons: readonly StopReason[] = ALL_STOP_REASONS_RUNTIME,
): void => {
  const keys = new Set(Object.keys(table))
  const missing = reasons.filter((r) => !keys.has(r))
  if (missing.length > 0) {
    throw new Error(`STOP_CATEGORY_KIND_BY_STOP_REASON is missing: ${missing.join(", ")}`)
  }
  const known = new Set<string>(reasons)
  const extra = [...keys].filter((k) => !known.has(k))
  if (extra.length > 0) {
    throw new Error(`STOP_CATEGORY_KIND_BY_STOP_REASON has unknown keys: ${extra.join(", ")}`)
  }
}

assertStopReasonTablesInSync()

/** Stop category for the paused-awaiting-approval path (ALBB-18). The turn is
 *  RESUMABLE — a surface should render "waiting on you", never success. */
export const awaitingApprovalCategory = (): StopCategory => ({
  kind: STOP_CATEGORY_KIND_BY_STOP_REASON.awaiting_approval,
  reasonCode: STOP_REASON_CODE.SHELL_NEEDS_APPROVAL,
  hint: "Paused — waiting for your approval decision.",
})

/* ------------------------------------------------------------------------- *
 * Presentation table (aug-23 §13 slice 1b)
 *
 * Every render rail today re-derives its own mapping from the legacy 7-value
 * `reason` and falls through to success-looking copy on anything unrecognized
 * (§13: three such defaults shipped). This is the ONE table those rails
 * consume, so a new code cannot be added without deciding how it reads.
 *
 * `tone` is the surface-agnostic bucket. It is pinned to the classification
 * `exitCodeForOutcome` (src/apps/agent/run.ts:54) already ships, which is
 * currently the only place in the codebase that gets this right:
 *   success 0 · incomplete 1 · failed 1 · blocked 2 · refused 3 · cancelled 130
 * ------------------------------------------------------------------------- */

/** Surface-agnostic outcome bucket. `success` is reserved for genuine
 *  completion — never assign it to a stop that left work undone. */
export type StopTone = "success" | "incomplete" | "blocked" | "failed" | "cancelled" | "refused"

export interface StopPresentation {
  /** Short human label a surface may render verbatim. Distinct per code. */
  readonly label: string
  readonly tone: StopTone
}

/** Presentation for every {@link StopReasonCode}. Exhaustive by type. */
export const STOP_PRESENTATION_BY_REASON_CODE: Record<StopReasonCode, StopPresentation> = {
  [STOP_REASON_CODE.COMPLETED_NORMAL]: { label: "Done", tone: "success" },
  [STOP_REASON_CODE.COMPLETED_MAX_TURNS]: { label: "Stopped at turn limit", tone: "incomplete" },
  [STOP_REASON_CODE.USER_INTERRUPT]: { label: "Interrupted", tone: "cancelled" },
  [STOP_REASON_CODE.SYSTEM_ABORT]: { label: "Aborted by host", tone: "cancelled" },
  [STOP_REASON_CODE.BUDGET_COST_CAP]: { label: "Stopped at cost cap", tone: "blocked" },
  [STOP_REASON_CODE.BUDGET_LEDGER_BREACH]: { label: "Stopped at spend ceiling", tone: "blocked" },
  [STOP_REASON_CODE.SHELL_NEEDS_APPROVAL]: { label: "Waiting for approval", tone: "blocked" },
  [STOP_REASON_CODE.MODEL_REFUSAL]: { label: "Model declined", tone: "refused" },
  [STOP_REASON_CODE.MODEL_EMPTY_EXHAUSTED]: { label: "Model returned nothing", tone: "failed" },
  [STOP_REASON_CODE.MODEL_MALFORMED_TOOL_USE]: { label: "Tool call was malformed", tone: "failed" },
  [STOP_REASON_CODE.COMPACTION_THRASH]: { label: "Context compaction thrashed", tone: "failed" },
  [STOP_REASON_CODE.PROVIDER_RATE_LIMIT]: { label: "Provider rate limit", tone: "failed" },
  [STOP_REASON_CODE.PROVIDER_OVERLOADED]: { label: "Provider overloaded", tone: "failed" },
  [STOP_REASON_CODE.PROVIDER_NETWORK]: { label: "Network failure", tone: "failed" },
  [STOP_REASON_CODE.PROVIDER_AUTH]: { label: "Provider auth failed", tone: "failed" },
  [STOP_REASON_CODE.PROVIDER_BAD_REQUEST]: { label: "Malformed request", tone: "failed" },
  [STOP_REASON_CODE.PROVIDER_UNKNOWN]: { label: "Provider error", tone: "failed" },
  [STOP_REASON_CODE.RUNTIME_UNKNOWN_ERROR]: { label: "Unexpected error", tone: "failed" },
  [STOP_REASON_CODE.LOOP_NO_PROGRESS]: { label: "Stopped making progress", tone: "failed" },
}

const ALL_STOP_REASON_CODES_RUNTIME: readonly StopReasonCode[] = Object.values(STOP_REASON_CODE)

/**
 * Runtime drift guard for the presentation table. Injectable args exist ONLY so
 * the hellgate can prove the guard fires (red-on-injection).
 */
export const assertStopPresentationInSync = (
  table: Record<string, StopPresentation> = STOP_PRESENTATION_BY_REASON_CODE,
  codes: readonly StopReasonCode[] = ALL_STOP_REASON_CODES_RUNTIME,
): void => {
  const keys = new Set(Object.keys(table))
  const missing = codes.filter((c) => !keys.has(c))
  if (missing.length > 0) {
    throw new Error(`STOP_PRESENTATION_BY_REASON_CODE is missing: ${missing.join(", ")}`)
  }
  const known = new Set<string>(codes)
  const extra = [...keys].filter((k) => !known.has(k))
  if (extra.length > 0) {
    throw new Error(`STOP_PRESENTATION_BY_REASON_CODE has unknown keys: ${extra.join(", ")}`)
  }
}

assertStopPresentationInSync()

/** Presentation for a reason code. An UNKNOWN code degrades to a `failed`
 *  tone — never to `success`. Falling through to success on an unrecognized
 *  value is the exact competitor bug §13 documents. */
export const stopPresentationFor = (reasonCode: string): StopPresentation =>
  STOP_PRESENTATION_BY_REASON_CODE[reasonCode as StopReasonCode] ?? {
    label: "Stopped for an unrecognized reason",
    tone: "failed",
  }
