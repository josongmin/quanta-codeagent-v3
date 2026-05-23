/**
 * Long-term memory configuration blocks (RFC §6.3) — extracted from
 * `src/agent/types.ts` so the per-feature option shapes have a discoverable
 * home and `AgentConfig` doesn't carry their nested literal forms inline.
 *
 * SHAPES MUST stay byte-identical to the previous inline declarations:
 * `AgentConfig.memory` and `AgentConfig.memoryConsolidator` declaration-merge
 * via consumers reading the full `AgentConfig`, and the `MemoryConfig`
 * `Pick<>` re-exported from `./types` resolves these typed slots. Adding /
 * renaming a field here is a CONTRACT CHANGE — bump the surface, don't
 * silently widen.
 *
 * Default-OFF posture (RFC §1.2):
 *   - `memory` absent ⇒ all defaults; with no `store` the whole block is inert.
 *   - `memoryConsolidator` absent ⇒ no consolidator runs at session-end.
 */

import type { Phase1Port, Stage1StorePort } from "@/memory"

/**
 * Nested option shape for `AgentConfig.memory` — long-term memory tuning
 * (RFC §6.3). Absent ⇒ all defaults; with no `store` the whole block is inert.
 * Behavior-preserving when unset.
 *
 * Declared as a `type` alias (anonymous object shape) — NOT an interface —
 * so that the resolved `AgentConfig["memory"]` stays structurally
 * assignable to `Record<string, unknown>` (existing slog / observability
 * call sites pass it directly).
 */
export type MemoryConfigBlock = {
  /** Max entries folded into the recall context block. Default 5. */
  recallLimit?: number
  /**
   * LLM-distill the finished transcript into structured records on session
   * end (vs. the heuristic final-text dump). Default `true` when `llm` can
   * serve it; ignored if it fails (graceful degrade to the heuristic).
   */
  distill?: boolean
  /**
   * Consolidate each new record against near-duplicates (LLM-arbitrated
   * merge/supersede). Default `true` when `embedder` is present.
   */
  consolidate?: boolean
  /** Per-tier caps for the post-persist eviction sweep. Defaults: see eviction.ts. */
  evictionCaps?: { semanticMax?: number; episodicMax?: number }
  /** Register the self-edit memory tools (memory_search/write/update). Default `true` when `store` is present. */
  selfEditTools?: boolean
  /**
   * Restrict per-turn recall to these tiers (long-term memory, RFC §6.3).
   * Absent ⇒ recall spans all tiers (behavior-preserving). e.g.
   * `["semantic"]` recalls only durable distilled knowledge.
   */
  recallTiers?: ("episodic" | "semantic")[]
}

/**
 * Nested option shape for `AgentConfig.memoryConsolidator` — ADR-0068 2-phase
 * memory consolidator session-end hook (L4 wire). Absent ⇒ no consolidator
 * runs at session-end (byte-identical for every legacy caller — RFC §1.2
 * default-OFF). When set, the loop's `runAgent` finally calls `runPhase1`
 * IFF the session ended without an error (spanStatus === "ok") and either:
 *   - `enabled: true` (auto-trigger on session-end), OR
 *   - `forceSummarization: true` (SOTA Cursor `force_summarization` — runs
 *     even when the per-thread turn-count would otherwise skip,
 *     surfacing in the consolidator's `memoryMode: "enabled"` arm).
 * Errors are caught and surfaced as `error` AgentEvents (non-fatal —
 * the session is already finishing); they do NOT propagate.
 *
 * Phase 2 (cross-session synthesizer + writer) is NON-GOAL for the
 * session-end hook (per audit: Phase 2 is threshold / explicit-trigger
 * driven, not cron). The host runs Phase 2 separately when ready.
 */
export type MemoryConsolidatorBlock = {
  /** Auto-trigger Phase 1 on session-end (spanStatus === "ok"). */
  enabled?: boolean
  /** SOTA Cursor `force_summarization` — when true, the per-thread
   *  `memoryMode` arm fires `"enabled"` even if the host did not set
   *  `enabled: true`, AND the call runs even when this would otherwise
   *  be skipped. */
  forceSummarization?: boolean
  /** LLM-backed Phase1Port (distill rollout → summary + rawMemory +
   *  preferenceSignals). REQUIRED to actually run Phase 1; absent ⇒
   *  the hook records a skip (no LLM port wired) without throwing. */
  port?: Phase1Port
  /** Stage1Store (SQLite upsert sink). REQUIRED; absent ⇒ skip. */
  store?: Stage1StorePort
  /** Stable thread id for the Stage1Output PRIMARY KEY. Falls back to
   *  `config.sessionId` when omitted; if BOTH are absent the call is
   *  skipped (the consolidator refuses an empty thread id). */
  threadId?: string
}
