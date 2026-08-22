/**
 * Agent outcome surface — what `runAgent` returns at session end. Extracted
 * from `src/agent/types.ts` (cohesion split) so the outcome shape can be
 * imported without pulling in `AgentConfig`'s full dependency graph
 * (LLM/permission/memory/stream/...).
 *
 * Byte-identical: every name re-exports verbatim through `./types`, so the
 * 132 consumer files that import `from "./types"` (or `"@/agent/types"`) are
 * unchanged.
 */

import type { Message } from "@/llm"
import type { TurnTiming } from "@/observability"
import type { RedactionKind, RedactionOrigin } from "@/security"
import type { StopCategory } from "../stop-category"

/**
 * Aggregated redaction counts surfaced on {@link AgentOutcome}. Per-hit
 * detail (span / placeholder / origin file) lives in the on-disk JSONL
 * envelope; the outcome carries the rollup so a host can render "N
 * secrets hidden" without scanning the trajectory.
 */
export interface RedactionRollup {
  readonly origin: RedactionOrigin
  readonly kind: RedactionKind
  readonly count: number
}

export type StopReason =
  | "completed"
  | "max_turns"
  | "aborted"
  | "error"
  | "budget_exhausted" /* RFC may-22 — BudgetMeter cap hit before completion */
  | "refusal" /* ADR-0076 Gap-1 SOTA++ — model returned stop_reason=refusal;
                 `AgentOutcome.refusal.rationale` carries the visible-text
                 reason. Distinct from `error` so a host can render "model
                 refused" without inspecting the message stream. */
  | "awaiting_approval" /* ALBB-18 — the turn is PAUSED awaiting a human-in-the-
                 loop approval decision (returned by `approvalPlaceholderOutcome`
                 alongside an `approvalRequest`; matches scheduler status
                 `"awaiting_approval"`). NOT terminal / NOT user-cancelled —
                 distinct from `aborted` so a consumer reading `outcome.reason`
                 can tell "paused, resume pending" from "cancelled". Classified
                 to `"partial"` (resumable, incomplete) by the reactor SSOT. */

/**
 * memory_citation provenance surface (ADR-0082). A record is "cited" iff it
 * was actually placed into the prompt window for some turn of the run —
 * provenance, NOT a heuristic match of the assistant's response text.
 *
 * Closed `where` enum encodes the placement seam:
 *   - `system_prompt`         — folded into the static system prompt body.
 *   - `reminder_tail`         — appended into the per-turn trailing
 *                               `<system-reminder>` user message (the only
 *                               site quanta currently renders recall blocks,
 *                               so this is the value most citations carry).
 *   - `tool_result_injection` — wrapped into a synthetic `tool_result`
 *                               observation. Reserved for the seam; no
 *                               builder writes this value today.
 *
 * The signal is ALWAYS captured when the memory subsystem is wired (no opt-in
 * flag); the surface is the optional `AgentOutcome.memoryCitations` array.
 * With no memory recall (store absent or no entries placed) the array is
 * empty and the field is OMITTED from the outcome — byte-identical for
 * callers that ignore it.
 */
export interface MemoryCitation {
  /** Stable id of the placed memory record (matches `MemoryEntry.id`). */
  readonly recordId: string
  /** Recall score that placed the record in the prompt window. The exact
   *  weighted-sum value `rankEntries` computed; comparable across citations
   *  in the SAME turn (score scale depends on query, so cross-turn comparison
   *  is informational only). */
  readonly score: number
  /** Closed enum — where the record was rendered into the prompt window. */
  readonly where: "system_prompt" | "reminder_tail" | "tool_result_injection"
  /** Approximate token cost of the record's text contribution to the prompt
   *  (chars/4 heuristic, the same estimator the rest of the loop uses).
   *  Omitted when the prompt assembler could not size the contribution. */
  readonly tokensApprox?: number
}

export interface AgentOutcome {
  reason: StopReason
  turns: number
  /** Full transcript including tool results, for resume/inspection. */
  messages: Message[]
  /**
   * Structured stop category (ADR-0063, Spec B3). Optional add-on; when
   * present a surface can render a richer "why" than the 4-element
   * {@link StopReason} can express. Default-OFF (absent on every legacy
   * outcome) ⇒ byte-identical for callers that only read `reason`.
   */
  stopCategory?: StopCategory
  /**
   * memory_citation provenance surface (ADR-0082). Append-only across the
   * run: every time a recall block lands in the prompt window for some turn,
   * one {@link MemoryCitation} per placed record is appended (dedup is NOT
   * applied — a record placed across N turns surfaces N citations, so a
   * trajectory consumer can see "this record was anchored for N turns"). The
   * field is OMITTED when no citations were captured (no store wired, or no
   * recall hits across the whole run) — byte-identical for callers that
   * only read `reason`.
   */
  memoryCitations?: ReadonlyArray<MemoryCitation>
  /**
   * ADR-0077 TTFT trio — wall-clock anchors of the LAST sampling-request of
   * the run (the one that produced the final assistant message). Absent on
   * runs that never opened a stream (e.g. immediate abort) ⇒ byte-identical
   * for callers that only read `reason`. Captured by
   * `createTurnTimingCapture`, with `requestSentAt` stamped by the adapter at
   * the actual provider POST boundary.
   */
  turnTiming?: TurnTiming
  /**
   * Aggregated secret-redaction hit counts (ADR-0078). Present whenever
   * redaction is enabled AND at least one hit fired during the run.
   * Absent ⇒ either no hits OR the layer is opt-out disabled. The host
   * may render the rollup as "N secrets hidden" without scanning the
   * trajectory. Per-hit detail (`RedactionHit`) lives in the JSONL
   * envelope. Closed enum keys keep the rollup audit-stable.
   */
  redactions?: ReadonlyArray<RedactionRollup>
  /**
   * ADR-0076 Gap-1 SOTA++ — model returned `stop_reason="refusal"`. Present
   * iff `reason === "refusal"`. `rationale` is the concatenated visible-text
   * blocks of the final assistant message (thinking / redacted_thinking are
   * NOT included — those are private reasoning, not the model's SAY). Empty
   * string when the refusal carried no visible text (rare; surface "Refused
   * without rationale" at the UI layer). The field is OMITTED for every
   * non-refusal outcome so byte-identical legacy callers see no new key.
   */
  refusal?: { readonly rationale: string }
}
