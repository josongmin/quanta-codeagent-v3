/**
 * Compaction configuration blocks + pre-compact HITL types — extracted from
 * `src/agent/types.ts` so the compaction surface has a single discoverable
 * home and `AgentConfig` doesn't carry the literal shapes inline.
 *
 * SHAPES MUST stay byte-identical to the previous inline declarations:
 * `AgentConfig.compaction`, `AgentConfig.compactionBreaker`, and
 * `AgentConfig.onPreCompact` declaration-merge with `SafetyConfig`
 * (compactionBreaker lives there too) and `RecoveryConfig` (Pick<> over the
 * compaction + breaker + onPreCompact slots). Adding / renaming a field here
 * is a CONTRACT CHANGE — bump the surface, don't silently widen.
 *
 * Default-OFF posture (RFC §1.2):
 *   - `compaction` absent ⇒ compaction is skipped entirely.
 *   - `compactionBreaker` absent ⇒ the breaker uses defaults
 *     (`DEFAULT_COMPACTION_BREAKER_CAPS`); the breaker is ON by default but
 *     only trips on pathological compaction thrash.
 *   - `onPreCompact` absent ⇒ auto-approve, byte-identical legacy.
 */

import type { LLMPort } from "@/llm"
import type { CompactionBreakerCaps } from "../compaction-breaker"

/**
 * Cursor-style pre-compact HITL query payload (ADR-0075). Built by the loop at
 * the moment a proactive compaction is about to fire and passed to
 * `AgentConfig.onPreCompact`. Fields are POST-decision proposals — `proposedKeep`
 * is the keepRecentTurns that will be used, `proposedSummaryTokens` is a
 * heuristic estimate based on the summarizable prefix size (so a UI can warn
 * "this will summarize ~12k tokens of history").
 *
 * `turnId` is the canonical turn identifier (the loop already stamps
 * `RunContext.turn` per turn; the query uses a stringified form to stay
 * stable across an eventual id-shape change). When no `RunContext` is wired,
 * the loop synthesizes a deterministic `t<n>` id from the turn counter so the
 * surface always sees a string.
 */
export interface PreCompactRequestQuery {
  /** Stable identifier for the turn whose top is firing the compaction. */
  turnId: string
  /** Estimated tokens of the current transcript (chars/4 heuristic) — the
   *  signal that crossed the threshold. */
  currentTokens: number
  /** The configured / resolved threshold that was crossed. */
  threshold: number
  /** keepRecentTurns proposed by the loop — typically the configured value. */
  proposedKeep: number
  /** Heuristic estimate of how much transcript will be folded into the
   *  summary, in tokens — i.e. the size of the SUMMARIZABLE PREFIX (not the
   *  size of the produced summary, which is typically a fraction of this).
   *  Surfaced for UI prompts like "this will summarize up to ~Nk tokens of
   *  history". Not used by the loop. */
  proposedSummaryTokens: number
}

/**
 * User decision returned from `AgentConfig.onPreCompact`:
 *   - `"approve"` — proceed with this compaction normally;
 *   - `"defer_one_turn"` — skip the compaction this turn; re-evaluate next turn;
 *   - `"force_now"` — proceed (same loop effect as `approve`) but with an
 *     explicit "user forced" marker that downstream emit/log layers may surface
 *     differently. The loop itself treats `force_now` and `approve` identically.
 */
export type PreCompactDecision = "approve" | "defer_one_turn" | "force_now"

/**
 * Nested option shape for `AgentConfig.compaction` — compaction tuning.
 * Absent ⇒ compaction is skipped entirely (existing suites with no compaction
 * config are unaffected).
 *
 * Declared as a `type` alias (anonymous object shape) — NOT an interface —
 * so that the resolved `AgentConfig["compaction"]` stays structurally
 * assignable to `Record<string, unknown>` (existing slog / observability
 * call sites pass these blocks directly).
 */
export type CompactionConfigBlock = {
  thresholdTokens?: number
  keepRecentTurns?: number
  /**
   * Dedicated LLM for the compaction SUMMARY turn (cost/latency,
   * ADR-0011). Summarization is a bounded, low-stakes task — a cheaper/
   * faster model is usually sufficient and avoids spending the main model
   * on every 120k-token compaction. Absent ⇒ uses `config.llm` (the main
   * model), so behavior is byte-identical when unset. Tradeoff: a weaker
   * summarizer can degrade resumed-context fidelity — opt in deliberately.
   */
  summarizerLlm?: LLMPort
  /**
   * Cursor-style sliding-window archive of per-compaction summaries
   * (ADR-0075). When `true`, the loop builds a session-scoped
   * `ConversationSummaryArchive` and appends a
   * `ConversationSummaryEntry` after every proactive compaction; an
   * `event_msg:context_compacted` AgentEvent is emitted at the same seam so
   * a session jsonl recorder / UI can render the compaction history.
   * Absent/`false` ⇒ no archive constructed, no event emitted, the loop is
   * byte-for-byte identical to the pre-archive path.
   */
  archive?: boolean
}

/**
 * Nested option shape for `AgentConfig.compactionBreaker` — circuit-breaker
 * control (Tier 0 safety hardening, ADR-0011). The breaker is ON by default
 * with `DEFAULT_COMPACTION_BREAKER_CAPS` — it only trips on pathological
 * compaction thrash (≥N consecutive no-progress compactions), so normal
 * flows are unaffected. `disabled:true` opts out; `caps` overrides
 * individual thresholds.
 *
 * MUST stay structurally identical to `SafetyConfig.compactionBreaker` —
 * the two interface declarations merge into `AgentConfig`.
 */
export type CompactionBreakerOptions = {
  disabled?: boolean
  caps?: Partial<CompactionBreakerCaps>
}

/**
 * Callback shape for `AgentConfig.onPreCompact` — Cursor-style pre-compact
 * HITL hook (ADR-0075). When the proactive compaction path is ABOUT to fire
 * (token threshold crossed AND a summarizable boundary exists), the loop
 * builds a `PreCompactRequestQuery` and awaits this callback. Decisions:
 *   - `"approve"` (default when this callback is ABSENT, preserving
 *      byte-identical legacy) — proceed with the compaction;
 *   - `"defer_one_turn"` — skip THIS turn's compaction; the proactive path
 *      will be re-evaluated next turn (the breaker still observes the no-op);
 *   - `"force_now"` — proceed regardless of any host-side deferral logic
 *      (the loop treats it like `approve`; the distinct value is kept so a
 *      UI can record "user explicitly forced it").
 * Errors thrown from the callback are caught and surfaced as an `error`
 * AgentEvent, then the compaction is deferred this turn (fail-safe: never
 * fold history without an answer). Absent ⇒ auto-approve, byte-identical.
 */
export type OnPreCompactCallback = (query: PreCompactRequestQuery) => Promise<PreCompactDecision>
