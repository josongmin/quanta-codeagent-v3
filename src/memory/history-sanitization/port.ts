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
 *   - Closed. Adding a method requires a new ADR. The two replace-methods
 *     cover the Codex parity case (`replaceLastTurnImages`) and the more
 *     aggressive "scrub the last N messages" pass needed when an image
 *     survived multiple turns (a quanta-specific extension since our turn
 *     boundary is structural rather than indexed). The `snapshotMessages`
 *     read accessor was added by ADR-0337 (closed-port extension log below).
 *
 * # Closed-port extension log
 *
 * The interface is closed-port: widening it requires a new ADR that
 * explicitly amends this section. The original ADR-0323 sealed two methods
 * (`replaceLastTurnImages`, `replaceLastNMessagesImages`); subsequent rows
 * record each amendment.
 *
 * | date       | ADR       | transition | added member           | rationale (1-line)                                                       |
 * |------------|-----------|------------|------------------------|--------------------------------------------------------------------------|
 * | 2026-05-27 | ADR-0337  | 2 → 3      | `snapshotMessages()`   | wm-live re-snapshot accessor so retry decorators see the sanitized turn instead of the caller's stale `input.messages` reference (closes ADR-0328/0333 limitation). |
 *
 * The `snapshotMessages` member is additive — it does not replace, shadow,
 * or alter either of the original two methods, and the mutation channel is
 * unaffected. Consumer wiring lives in ADR-0337.
 *
 * # Sibling: `reconcileToolPairing` (resume-boundary tool-pair reconciliation)
 *
 * The dangling-`tool_use`↔`tool_result` repair (jun-04 B4) lives in this slice
 * as a PURE array→array sibling export (`./reconcile-tool-pairing.ts`), NOT as a
 * method on this port. Rationale: this port is a *stateful* mutation channel
 * bound to a live `WorkingMemory<Message>` (the in-session buffer). The B4
 * repair runs on a transcript freshly LOADED from disk on resume/fork/rewind —
 * a plain `readonly Message[]`, before any `WorkingMemory` exists. Forcing it
 * through the wm-bound interface would be the wrong contract shape. It shares
 * the slice's posture (pure, no-throw, slice-fence-clean, byte-identical when
 * already valid) but stands alone. See its module header for the algorithm +
 * the orphan-`tool_use` synthesize-vs-drop decision.
 */

import type { SanitizationReason, SanitizationResult } from "./types"

/** Structural minimum for a message returned by {@link HistorySanitizationPort.snapshotMessages}.
 *  Matches `Message` from `@/llm/types.ts` without importing it (slice-fence:
 *  `@/memory` must not import `@/llm`). Callers that need the concrete
 *  `Message` shape can cast at the wire boundary — the port is structural. */
export interface SanitizationMessageLike {
  readonly role: string
  readonly content: unknown
}

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

  /**
   * ADR-0337 — return the current wm messages snapshot.
   *
   * Used by retry decorators (notably `withImageSanitizationRetry`) to
   * re-snapshot the wm AFTER a `replaceLast*Images` call mutated the buffer,
   * so the retry sees the SANITIZED turn rather than the caller's stale
   * `input.messages` reference (the snapshot taken by the loop BEFORE the
   * pre-sanitize stream attempt).
   *
   * Contract:
   *   - NO-THROW. Adapters MUST swallow every error and return `[]` rather
   *     than poison the retry loop. Consumers treat a thrown / empty result
   *     as "fall back to the caller's `input.messages`".
   *   - Snapshot semantics. The returned array MUST be a shallow copy (or
   *     `readonly` view) of the wm's current buffer; mutating the returned
   *     reference MUST NOT poison the wm. The default adapter delegates to
   *     `wm.snapshot()`, which is already a defensive shallow copy.
   *   - Cheap. Called once per retry attempt by the decorator — adapters
   *     SHOULD not allocate beyond the snapshot copy.
   */
  snapshotMessages(): readonly SanitizationMessageLike[]
}
