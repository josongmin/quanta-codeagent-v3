import type { Message, ToolResultBlock } from "@/llm"
import {
  EVICTED_PLACEHOLDER,
  type MicrocompactInput,
  type MicrocompactResult,
  validateMicrocompactTuning,
} from "./types"

/**
 * Pure tool-result eviction pre-pass (RFC §4.3). No `Date.now`, no
 * `Math.random`, no env read, no IO except the single injected `spill.persist`
 * call. The clock / time-based trigger lives in the WIRE (`compaction-wire.ts`),
 * NOT this core — mirrors how `compaction.ts` keeps the clock in the controller.
 *
 * Algorithm: forward-scan collecting every tool_result block in order → protect
 * the last `keepRecent` → for each older candidate, skip-if-already-cleared,
 * estimate `tokensSaved`, gate on the floor, then rebuild a new message array
 * with the cleared bodies. Clearing CONTENT (not removing the block) keeps every
 * `tool_use`↔`tool_result` pairing intact — no orphan walk (§3.3).
 */

/** Rough context-token footprint of an image, in chars. Mirrors
 *  `compaction.ts#IMAGE_CHAR_ESTIMATE` (ADR-0083) so the saving estimate is
 *  consistent with the threshold the loop gates on (§4.8). */
const IMAGE_CHAR_ESTIMATE = 6000

/** Rough context-token footprint of a PDF document, in chars. Mirrors
 *  `compaction.ts#DOCUMENT_CHAR_ESTIMATE` (ADR-0137). */
const DOCUMENT_CHAR_ESTIMATE = 12000

/** Char weight of a tool_result block, INCLUDING the heavy `contentBlocks`
 *  (image/document) payload that clearing reclaims. The `content` string weight
 *  matches `compaction.ts#blockChars` (`tool_result` ⇒ `content.length`); the
 *  `contentBlocks` weight is added so an image-heavy result is correctly seen as
 *  a big save and the floor gate fires on it (§4.8). */
const toolResultWeight = (b: ToolResultBlock): number => {
  let chars = b.content.length
  for (const part of b.contentBlocks ?? []) {
    switch (part.type) {
      case "text":
        chars += part.text.length
        break
      case "image":
        chars += IMAGE_CHAR_ESTIMATE
        break
      case "document":
        chars += DOCUMENT_CHAR_ESTIMATE
        break
    }
  }
  return chars
}

/** A tool_result is "already cleared" iff its body begins with the sentinel —
 *  covers the bare placeholder and a placeholder followed by the port's line
 *  (persisted ref or unpersisted-reason block) (§4.5), so a second pass never
 *  re-clears / re-spills / double-counts. */
const isCleared = (b: ToolResultBlock): boolean => b.content.startsWith(EVICTED_PLACEHOLDER)

/** Indices `(i, j)` of every tool_result block, in forward order. */
type Ref = { readonly i: number; readonly j: number }

const collectToolResults = (messages: readonly Message[]): Ref[] => {
  const refs: Ref[] = []
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]?.content
    if (content === undefined) continue
    for (let j = 0; j < content.length; j++) {
      if (content[j]?.type === "tool_result") refs.push({ i, j })
    }
  }
  return refs
}

/** Build the cleared body for a block: hand the original to the spill port, then
 *  return the sentinel followed on the next line by whatever the port returned —
 *  a persisted ref or an unpersisted-reason block — so idempotency stays a single
 *  `startsWith`. A port that returns undefined, or throws (NO-THROW), gives the
 *  bare placeholder. */
const clearedBody = (original: ToolResultBlock, spill: MicrocompactInput["spill"]): string => {
  if (spill === undefined) return EVICTED_PLACEHOLDER
  let ref: string | undefined
  try {
    ref = spill.persist(original.content, original.tool_use_id)
  } catch {
    // NO-THROW: a throwing port degrades to a bare-placeholder clear.
    ref = undefined
  }
  return ref === undefined ? EVICTED_PLACEHOLDER : `${EVICTED_PLACEHOLDER}\n${ref}`
}

/**
 * Run the pre-pass. Returns the input array reference unchanged (no allocation)
 * when the estimated saving does not clear the floor — byte-identical
 * pass-through.
 */
export const microcompactToolResults = (input: MicrocompactInput): MicrocompactResult => {
  const { messages, keepRecent, tokensSavedFloor } = input
  // DOF-40 fail-closed — refuse an out-of-bounds boundary BEFORE any scan/evict.
  // `keepRecent<=0` would evict the live working set; a non-integer `keepRecent`
  // corrupts the protect-slice; a `NaN`/negative `tokensSavedFloor` defeats the
  // floor gate (`<= NaN` is always false ⇒ unbounded commit). A typed throw makes
  // that visible; the wire fails-closed (skips the pass) instead of crashing.
  validateMicrocompactTuning(keepRecent, tokensSavedFloor)
  const refs = collectToolResults(messages)
  // Protect the LAST `keepRecent` tool_results (the live working set); a
  // non-positive keepRecent protects none. Everything earlier is a candidate.
  const protectedFrom = Math.max(0, refs.length - Math.max(0, keepRecent))
  const candidates = refs.slice(0, protectedFrom)

  // First pass: which candidates are clearable, and how many chars do they free?
  // The per-block saving is `weight(old) - placeholder.length` (the cleared body
  // has a small positive length). Cleared (idempotent-skip) blocks free nothing.
  const clearable: Ref[] = []
  let charsSaved = 0
  for (const ref of candidates) {
    const block = messages[ref.i]?.content[ref.j] as ToolResultBlock
    if (isCleared(block)) continue
    const saving = toolResultWeight(block) - EVICTED_PLACEHOLDER.length
    if (saving <= 0) continue
    clearable.push(ref)
    charsSaved += saving
  }

  // Honest estimate using the SAME chars/4 accounting as `estimateTokens`.
  const tokensSavedEstimate = Math.ceil(charsSaved / 4)

  if (clearable.length === 0 || tokensSavedEstimate <= tokensSavedFloor) {
    // Byte-identical pass-through — NO spill IO, NO new array (§4.3 step 5).
    return {
      messages,
      changed: false,
      toolsCleared: 0,
      tokensSavedEstimate,
    }
  }

  // Commit: rebuild a new array where each clearable block is a NEW
  // ToolResultBlock with its body rewritten (and `contentBlocks` DROPPED — the
  // stale image/document payload is exactly what we reclaim, §4.8). Every other
  // block (and the protected recent tool_results, and all assistant
  // text/thinking/tool_use) is carried BY REFERENCE — verbatim.
  const clearSet = new Map<number, Set<number>>()
  for (const ref of clearable) {
    let set = clearSet.get(ref.i)
    if (set === undefined) {
      set = new Set<number>()
      clearSet.set(ref.i, set)
    }
    set.add(ref.j)
  }

  const out: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Message
    const toClear = clearSet.get(i)
    if (toClear === undefined) {
      out.push(msg)
      continue
    }
    const newContent = msg.content.map((block, j) => {
      if (!toClear.has(j) || block.type !== "tool_result") return block
      const cleared: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: clearedBody(block, input.spill),
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      }
      return cleared
    })
    out.push({ ...msg, content: newContent })
  }

  return {
    messages: out,
    changed: true,
    toolsCleared: clearable.length,
    tokensSavedEstimate,
  }
}
