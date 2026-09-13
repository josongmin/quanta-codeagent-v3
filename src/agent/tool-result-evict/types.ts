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
 *  — a bare clear and a clear carrying the port's line (persisted ref or
 *  unpersisted-reason block) all begin with this sentinel. */
export const EVICTED_PLACEHOLDER = "[Old tool result content cleared]"

/**
 * Persist seam: hand the original body to disk, get back the line to embed in
 * the cleared block after the placeholder.
 *
 * The returned string is one of two things: a retrieval ref (a
 * `<persisted-output path=…>` marker, the original was written and can be
 * Read), or an `<unpersisted-output>` block (the original was NOT written, and
 * the block says why). The default adapter (`spill-adapter.ts`) returns the
 * second when `src/tool/output-spill.ts` refuses the spill directory or the
 * write fails. Returning `undefined` or throwing ⇒ the bare placeholder.
 * Injected so the pre-pass stays pure + testable; the default adapter reuses the
 * output-spill directory guard, file convention and prune (§4.4). NO-THROW
 * contract: a throwing port degrades to a bare-placeholder clear, it never
 * aborts the pre-pass.
 */
export interface EvictionSpillPort {
  /** Persist `body`, keyed by `toolUseId`; return a persisted ref, an
   *  unpersisted-reason block, or undefined for the bare placeholder. */
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

/**
 * DOF-40 fail-closed hardening — the typed refusal the pure core throws when the
 * tuning it is HANDED is out of bounds (NOT "absent": absent is the wire's job,
 * it substitutes named safe defaults BEFORE calling the core). A bad boundary
 * that once silently mis-evicted (`keepRecent<=0` ⇒ ALL tool_results evicted incl.
 * the live working set; a non-integer `keepRecent` ⇒ bogus slice arithmetic; a
 * `NaN` `tokensSavedFloor` ⇒ the floor gate `<= NaN` is ALWAYS false ⇒ unbounded
 * commit) must now become a VISIBLE typed failure the wire fails-closed on, never
 * a silent wrong eviction. This is a refusal, NOT an invented threshold — the
 * bounds are the type contract (`keepRecent` ≥ 1 integer; `tokensSavedFloor` a
 * finite ≥ 0 integer), not a heuristic magnitude.
 */
export class MicrocompactTuningError extends Error {
  readonly param: "keepRecent" | "tokensSavedFloor"
  readonly value: number
  constructor(param: "keepRecent" | "tokensSavedFloor", value: number) {
    super(
      `microcompact tuning out of bounds: ${param}=${String(value)} — ` +
        (param === "keepRecent"
          ? "keepRecent must be a positive integer (≥1) so at least one recent tool_result is retained"
          : "tokensSavedFloor must be a finite non-negative integer"),
    )
    this.name = "MicrocompactTuningError"
    this.param = param
    this.value = value
  }
}

/** Validate the tuning the core was HANDED. Throws {@link MicrocompactTuningError}
 *  on any out-of-bounds value (see that error's contract). Pure; no default
 *  substitution here — the wire supplies validated named defaults for the
 *  env-ABSENT case, and this guard makes a bad IN-RANGE value fail visibly instead
 *  of silently mis-evicting. */
export const validateMicrocompactTuning = (keepRecent: number, tokensSavedFloor: number): void => {
  if (!Number.isInteger(keepRecent) || keepRecent < 1)
    throw new MicrocompactTuningError("keepRecent", keepRecent)
  if (!Number.isInteger(tokensSavedFloor) || tokensSavedFloor < 0)
    throw new MicrocompactTuningError("tokensSavedFloor", tokensSavedFloor)
}
