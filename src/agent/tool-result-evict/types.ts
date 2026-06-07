import type { Message } from "@/llm"

/**
 * Time-based microcompaction — selective tool-result eviction (RFC
 * `docs/plans/jun-6-microcompaction.md`). This is the content-clearing tier-1
 * mechanism: BEFORE a full LLM summarization, retroactively NULL OUT the bodies
 * of OLD tool_result blocks (keeping the last `keepRecent` intact), reclaiming
 * context for ZERO LLM cost and ZERO loss of conversational reasoning.
 *
 * Unlike a whole-MESSAGE drop (a naive FIFO `createMicroCompactor` once lived in
 * `src/agent/microcompact/`, deleted jun-7 Phase-2 M5 as dead/unwired/orphan-
 * unaware), here we clear the CONTENT of a tool_result IN PLACE and KEEP the
 * block, so every `tool_use`↔`tool_result` pairing is structurally preserved —
 * no boundary walk, no orphan set (RFC §3.3). This is the ONLY live tier-1 path.
 */

/** The literal placeholder a cleared tool_result body is rewritten to. The
 *  idempotency check (§4.5) is a single `content.startsWith(EVICTED_PLACEHOLDER)`
 *  — both a bare clear and a spill-ref clear begin with this sentinel. */
export const EVICTED_PLACEHOLDER = "[Old tool result content cleared]"

/**
 * Persist seam: hand the original body to disk, get back a retrieval ref (the
 * `<persisted-output>` marker string) to embed in the cleared block.
 *
 * Returns `undefined` ⇒ clear with the bare placeholder (no spill). Injected so
 * the pre-pass stays pure + testable; the default adapter wraps the EXISTING
 * `src/tool/output-spill.ts#capToolOutput` (§4.4). NO-THROW contract: a spill
 * failure degrades to a bare-placeholder clear, it never aborts the pre-pass.
 */
export interface EvictionSpillPort {
  /** Persist `body`, keyed by `toolUseId`; return a ref marker or undefined. */
  persist(body: string, toolUseId: string): string | undefined
}

export interface MicrocompactInput {
  readonly messages: readonly Message[]
  /** Keep the LAST N tool_results intact (the live working set). */
  readonly keepRecent: number
  /** Commit ONLY if estimated tokensSaved > this floor (else byte-identical
   *  pass-through). A microcompact that frees almost nothing is a no-op. */
  readonly tokensSavedFloor: number
  /** Injected — persist originals before clearing. Omit ⇒ bare-placeholder. */
  readonly spill?: EvictionSpillPort
}

export interface MicrocompactResult {
  /** New message array IFF a clear happened; otherwise the input ref unchanged
   *  (no allocation — byte-identical pass-through). */
  readonly messages: readonly Message[]
  readonly changed: boolean
  readonly toolsCleared: number
  readonly tokensSavedEstimate: number
}
