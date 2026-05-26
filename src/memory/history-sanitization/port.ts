/**
 * ADR-0323 — closed `HistorySanitizationPort`.
 *
 * Mirror of Codex `codex-rs/core/src/session/turn.rs:363-371`'s
 * `state.history.replace_last_turn_images("Invalid image")` mutation, exposed
 * as a port so quanta call sites (a future Anthropic 400-invalid_image branch)
 * can scrub the in-session message buffer without reaching into
 * `WorkingMemory<Message>` internals.
 *
 * Contract:
 *   - NO-THROW. Adapters MUST swallow every error and return `replacedCount:0,
 *     wasMutated:false` rather than poison the live agent loop. The whole point
 *     of this port is to recover from a bad-state condition; throwing would
 *     defeat the purpose.
 *   - In-place. The Codex parent mutates `state.history` directly; our adapter
 *     calls `wm.replace(newMessages)` (the WorkingMemory's documented mutation
 *     API). Subsequent `wm.snapshot()` reads see the cleaned buffer.
 *   - Default-OFF. No production code wires this port in ADR-0323 — wiring at
 *     the adapter boundary is a follow-up ADR (see `0323-image-history-sanitization.md`
 *     "Non-goals").
 *   - Closed. Adding a method requires a new ADR. The two methods cover the
 *     Codex parity case (`replaceLastTurnImages`) and the more aggressive
 *     "scrub the last N messages" pass needed when an image survived multiple
 *     turns (a quanta-specific extension since our turn boundary is structural
 *     rather than indexed).
 */

import type { SanitizationReason, SanitizationResult } from "./types"

export interface HistorySanitizationPort {
  /**
   * Replace every `image` / `document` block in the LAST message (oldest →
   * newest order; the buffer's tail) with a `text` block carrying
   * {@link placeholder}. `tool_result.contentBlocks` arrays inside the last
   * message are also scrubbed (the Anthropic tool-result content surface is
   * where multimodal blocks land via `composeToolResultContent`).
   *
   * Returns `{replacedCount:N, wasMutated: N>0}`. `replacedCount` counts every
   * mutated block, not every mutated message — a single tool_result with three
   * image parts contributes 3. NO-THROW: adapter errors surface as
   * `{replacedCount:0, wasMutated:false}`.
   */
  replaceLastTurnImages(reason: SanitizationReason, placeholder: string): SanitizationResult

  /**
   * Same as {@link replaceLastTurnImages} but scoped to the LAST {@link n}
   * messages (oldest → newest order, so the last `n` are the tail). `n <= 0` is
   * a no-op; `n >= length` scrubs the whole buffer. NO-THROW.
   *
   * This is a quanta-specific extension to the Codex pattern: in our session
   * model an image can survive multiple turns (tool_result attachments), so a
   * single "last-turn" pass may miss the poisoning block. The two methods
   * share an implementation; a port-level distinction keeps the call-site
   * intent (Codex parity vs. multi-turn scrub) auditable.
   */
  replaceLastNMessagesImages(
    n: number,
    reason: SanitizationReason,
    placeholder: string,
  ): SanitizationResult
}
