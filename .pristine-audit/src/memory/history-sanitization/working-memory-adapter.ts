/**
 * ADR-0323 — `WorkingMemory`-backed adapter for `HistorySanitizationPort`.
 *
 * Codex parent (`codex-rs/core/src/session/turn.rs:363-371`):
 *
 *     if state.history.replace_last_turn_images("Invalid image") {
 *         continue;
 *     }
 *
 * The equivalent in quanta is to take a `WorkingMemory<Message>` (the agent
 * layer's session buffer), find every multimodal block (`image` /
 * `document`, including those inside `tool_result.contentBlocks`) in the
 * targeted suffix of the history, rewrite each to a `text` block carrying the
 * caller-supplied placeholder, and hand the new array back to the buffer via
 * `wm.replace(newMessages)`.
 *
 * WorkingMemory mutation API decision (recorded for the audit trail):
 *   The `WorkingMemory<M>` surface exposes `messages` (mutable backing array),
 *   `snapshot()` (defensive shallow copy), and `replace(messages: M[])`
 *   (defensive copy + swap). We use `snapshot()` + `replace()` rather than
 *   touching the `.messages` array in place because:
 *     1. `snapshot()` is the documented read surface; reaching into `.messages`
 *        bypasses the slice's invariant that message OBJECTS are treated as
 *        structurally immutable (header comment of `working.ts`).
 *     2. `replace()` already does the defensive copy, so the buffer's identity
 *        stays consistent (no torn reads if another consumer is mid-iteration
 *        on a prior `snapshot()` result).
 *     3. The Codex parent is `&mut self`, so we have the same atomicity story
 *        — one swap per call, observable as either old-buffer or new-buffer
 *        from any concurrent reader.
 *   This is full mutation parity with Codex; no read-only fallback was needed.
 *
 * Slice-fence: this adapter does NOT import `@/llm`. The `Message` /
 * `ContentBlock` shapes are accepted structurally via the generic `MsgLike`
 * parameter (mirroring how `WorkingMemory<M>` itself works). The actual
 * `Message` type from `@/llm/types.ts:1` is assignable.
 *
 * NO-THROW: every public method catches anything the buffer or block-walk
 * might throw and returns `{replacedCount:0, wasMutated:false}`. The whole
 * point of this port is to RECOVER from a poisoned-history condition — if it
 * crashed, the agent loop would be in a worse state than the original 400.
 */

import type { WorkingMemory } from "../working"
import type { HistorySanitizationPort, SanitizationMessageLike } from "./port"
import type { SanitizationReason, SanitizationResult } from "./types"

/** Structural minimum for a message in the buffer. Matches `Message` from
 *  `@/llm/types.ts` without importing it (memory slice isolation). */
interface MsgLike {
  role: string
  content: unknown
}

/** Structural shape of an inner block inside `message.content[]`. The discriminator
 *  fields we care about (`type`, optional `contentBlocks`) are narrowed at runtime. */
interface BlockLike {
  readonly type: string
  // `tool_result` carries an optional `contentBlocks` array (Anthropic shape) —
  // structural read only. Unknown to keep us free of `@/llm` types.
  readonly contentBlocks?: unknown
}

const EMPTY_RESULT: SanitizationResult = { replacedCount: 0, wasMutated: false }

/** Block types we replace. `image` (ADR-0083) + `document` (ADR-0137). */
const POISONABLE_BLOCK_TYPES = new Set<string>(["image", "document"])

/** Build the placeholder text block. Pure / deterministic — both helpers
 *  (top-level and inside `tool_result`) reuse it so the wire shape is uniform. */
const makeTextBlock = (text: string): { type: "text"; text: string } => ({
  type: "text",
  text,
})

/**
 * Walk a `tool_result.contentBlocks` array and rewrite every multimodal inner
 * block to a text placeholder. Returns the count of replacements + either the
 * SAME container reference (no mutation) or a shallow-cloned container with a
 * fresh `contentBlocks` array. Defensive: malformed entries are passed through
 * untouched and contribute 0.
 */
const sanitizeToolResultInner = (
  container: BlockLike,
  innerOld: ReadonlyArray<unknown>,
  placeholder: string,
): { block: unknown; replaced: number } => {
  let innerReplaced = 0
  const innerNew: unknown[] = new Array(innerOld.length)
  for (let j = 0; j < innerOld.length; j++) {
    const inner = innerOld[j]
    if (
      inner &&
      typeof inner === "object" &&
      POISONABLE_BLOCK_TYPES.has((inner as BlockLike).type)
    ) {
      innerNew[j] = makeTextBlock(placeholder)
      innerReplaced++
    } else {
      innerNew[j] = inner
    }
  }
  if (innerReplaced === 0) return { block: container, replaced: 0 }
  // Shallow-clone the tool_result block so prior snapshot consumers are not
  // aliased (`working.ts` documents message OBJECTS as structurally immutable).
  return {
    block: { ...(container as object), contentBlocks: innerNew },
    replaced: innerReplaced,
  }
}

/**
 * Rewrite a single block. Returns the (possibly new) block plus the count of
 * replacements contributed by this position. Pure; never throws on
 * legitimate inputs.
 */
const sanitizeOneBlock = (
  block: unknown,
  placeholder: string,
): { block: unknown; replaced: number } => {
  if (!block || typeof block !== "object") return { block, replaced: 0 }
  const b = block as BlockLike
  if (POISONABLE_BLOCK_TYPES.has(b.type)) {
    return { block: makeTextBlock(placeholder), replaced: 1 }
  }
  if (b.type === "tool_result" && Array.isArray(b.contentBlocks)) {
    return sanitizeToolResultInner(b, b.contentBlocks as ReadonlyArray<unknown>, placeholder)
  }
  return { block, replaced: 0 }
}

/**
 * Walk one message's `content` array and rewrite every multimodal block,
 * including blocks nested inside `tool_result.contentBlocks`. Returns either
 * the SAME message reference (no mutation needed — structural immutability) or
 * a brand-new message object with a brand-new `content` array.
 *
 * Pure function: no I/O, no telemetry, no exceptions thrown for legitimate
 * inputs. A malformed message (non-array content, non-object block) is left
 * untouched and contributes 0 to the count — defensive against StoredMessage
 * shapes we don't control.
 */
const sanitizeOneMessage = <M extends MsgLike>(
  msg: M,
  placeholder: string,
): { msg: M; replaced: number } => {
  if (!msg || typeof msg !== "object") return { msg, replaced: 0 }
  const content = msg.content
  if (!Array.isArray(content)) return { msg, replaced: 0 }

  let replaced = 0
  let mutated = false
  const newContent: unknown[] = new Array(content.length)

  for (let i = 0; i < content.length; i++) {
    const { block, replaced: r } = sanitizeOneBlock(content[i], placeholder)
    newContent[i] = block
    if (r > 0) {
      replaced += r
      mutated = true
    }
  }

  if (!mutated) return { msg, replaced: 0 }
  return { msg: { ...(msg as object), content: newContent } as M, replaced }
}

/**
 * Sanitize the trailing `n` messages of {@link wm}. `n` is clamped to
 * `[0, length]`. `n === 0` short-circuits (no buffer swap). Returns the
 * aggregate count + a single boolean indicating whether the buffer was
 * actually mutated (only true when at least one block was replaced).
 *
 * NO-THROW: every error path resolves to {@link EMPTY_RESULT}.
 */
const sanitizeTail = <M extends MsgLike>(
  wm: WorkingMemory<M>,
  n: number,
  placeholder: string,
): SanitizationResult => {
  try {
    if (!Number.isFinite(n) || n <= 0) return EMPTY_RESULT
    const snap = wm.snapshot()
    const length = snap.length
    if (length === 0) return EMPTY_RESULT
    const start = Math.max(0, length - Math.min(n, length))

    let totalReplaced = 0
    let anyMutated = false
    const next: M[] = new Array(length)
    for (let i = 0; i < length; i++) {
      const m = snap[i] as M
      if (i < start) {
        next[i] = m
        continue
      }
      const { msg, replaced } = sanitizeOneMessage(m, placeholder)
      next[i] = msg
      if (replaced > 0) {
        totalReplaced += replaced
        anyMutated = true
      }
    }
    if (!anyMutated) return EMPTY_RESULT
    wm.replace(next)
    return { replacedCount: totalReplaced, wasMutated: true }
  } catch {
    return EMPTY_RESULT
  }
}

/**
 * Construct a {@link HistorySanitizationPort} adapter bound to {@link wm}.
 *
 * The {@link SanitizationReason} parameter is passed through the port surface
 * for caller-side audit logs but is NOT consumed by the mutation logic — the
 * cleanup is the same regardless of reason. A future ADR may key per-reason
 * placeholder defaults or telemetry off it; that is intentionally not in
 * scope for ADR-0323.
 */
/**
 * Defensive snapshot used by {@link HistorySanitizationPort.snapshotMessages}.
 * NO-THROW: returns `[]` on any underlying failure (e.g. `wm.snapshot()`
 * crashing in a hostile adapter). The shape is widened structurally to
 * {@link SanitizationMessageLike} so the port surface does not require
 * consumers to know the concrete `Message` type.
 *
 * The cast `as readonly SanitizationMessageLike[]` is sound because
 * `M extends MsgLike` (`role`/`content`) which is a structural superset of
 * the port's `SanitizationMessageLike` (`readonly role`/`readonly content`):
 * a mutable `string` field is assignable to a `readonly string` viewing
 * position, and `wm.snapshot()` already returns `readonly M[]`.
 */
const safeSnapshot = <M extends MsgLike>(
  wm: WorkingMemory<M>,
): readonly SanitizationMessageLike[] => {
  try {
    return wm.snapshot() as unknown as readonly SanitizationMessageLike[]
  } catch {
    return []
  }
}

export const createWorkingMemoryHistorySanitization = <M extends MsgLike>(
  wm: WorkingMemory<M>,
): HistorySanitizationPort => ({
  replaceLastTurnImages(_reason: SanitizationReason, placeholder: string): SanitizationResult {
    return sanitizeTail(wm, 1, placeholder)
  },
  replaceLastNMessagesImages(
    n: number,
    _reason: SanitizationReason,
    placeholder: string,
  ): SanitizationResult {
    return sanitizeTail(wm, n, placeholder)
  },
  snapshotMessages(): readonly SanitizationMessageLike[] {
    return safeSnapshot(wm)
  },
})
