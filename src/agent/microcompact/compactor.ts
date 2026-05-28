/**
 * ADR-0409 — Microcompact factory.
 *
 * Pure function. NO-THROW on every input:
 *   - malformed `messages` (non-array, contains null) ⇒ returns input + provenance
 *     with `turnsDropped:0`.
 *   - `dropRatio` outside [0,1] ⇒ clamped to [0,1].
 *   - `preserveRecentTurns` >= messages.length ⇒ nothing drops (the protected
 *     suffix already covers everything).
 *
 * Algorithm:
 *   1. Compute target drop count = floor(messages.length * dropRatio).
 *   2. Walk from index 0 forward, skipping system messages when `preserveSystem`.
 *   3. NEVER cross into the protected suffix (last `preserveRecentTurns`).
 *   4. Drop the first `target` qualifying indices; keep everything else verbatim.
 *
 * The slice fence forbids `@/llm` (Message type lives there). Token estimate
 * uses a local chars/4 heuristic identical to `compaction.ts#estimateTokens`'s
 * intent — duplicated by design (slice leaf, RFC §3.1 "don't import @/llm just
 * for arithmetic"). The duplication is intentional and the unit cost is
 * trivial (a few cycles per character).
 */

import type { RecoveryProvenance } from "@/agent/recovery-reason"
import type {
  MicroCompactInput,
  MicroCompactorOpts,
  MicroCompactPort,
  MicroCompactResult,
} from "./types"

const DEFAULT_DROP_RATIO = 0.25
const DEFAULT_PRESERVE_RECENT_TURNS = 6

/** Clamp `n` to [lo, hi]. NaN ⇒ `lo` (NaN is "not in range" — treat as the
 *  conservative end of the interval). */
const clamp = (n: number, lo: number, hi: number): number => {
  if (Number.isNaN(n)) return lo
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

/** chars/4 token estimate over a heterogeneous message list. The slice cannot
 *  import `@/llm`'s richer estimator (would pull the whole llm package), so a
 *  small local walk is the right tradeoff: we only need a coarse number to
 *  populate provenance, not a faithful billing estimate. */
const estimateTokens = (messages: readonly { content: unknown }[]): number => {
  let chars = 0
  for (const m of messages) {
    // NO-THROW: a malformed entry (null / missing `content`) contributes
    // zero rather than crashing the walk.
    if (m === null || typeof m !== "object") continue
    chars += contentChars((m as { content?: unknown }).content)
  }
  return Math.ceil(chars / 4)
}

/** JSON.stringify with a bounded fallback for circular / unserializable
 *  values. Keeps `contentChars`'s try/catch out of its core flow. */
const safeJsonLength = (v: unknown): number => {
  try {
    return JSON.stringify(v).length
  } catch {
    return 64
  }
}

/** Length of a single content block (string / object). */
const blockChars = (b: unknown): number => {
  if (typeof b === "string") return b.length
  if (b !== null && typeof b === "object") return safeJsonLength(b)
  return 0
}

const contentChars = (content: unknown): number => {
  if (typeof content === "string") return content.length
  if (Array.isArray(content)) {
    let sum = 0
    for (const b of content) sum += blockChars(b)
    return sum
  }
  if (content !== null && typeof content === "object") return safeJsonLength(content)
  return 0
}

/** NO-THROW validation: the public API contract is that any input produces a
 *  result. Caller mistakes (non-array, null entries) collapse to a no-op +
 *  observable provenance. */
const isWellFormed = (input: MicroCompactInput): boolean => {
  if (!Array.isArray(input.messages)) return false
  for (const m of input.messages) {
    if (m === null || typeof m !== "object") return false
    if (typeof (m as { role?: unknown }).role !== "string") return false
  }
  return true
}

/** Build a no-op provenance + result for the malformed / no-drop branches.
 *  Provenance still carries `reason:"microcompact"` (the reason the consumer
 *  asked for one) so an observer sees a consistent kind across the slice. */
const buildNoOp = (input: MicroCompactInput, now: () => number): MicroCompactResult => {
  const tokens = input.tokenEstimate ?? estimateTokens(input.messages ?? [])
  const provenance: RecoveryProvenance = {
    reason: "microcompact",
    tokensBefore: tokens,
    tokensAfter: tokens,
    turnsDropped: 0,
    turnsKept: Array.isArray(input.messages) ? input.messages.length : 0,
    compactedAt: now(),
  }
  return {
    messages: Array.isArray(input.messages) ? input.messages : [],
    turnsDropped: 0,
    turnsKept: provenance.turnsKept,
    provenance,
  }
}

/** Build a "no drop happened" result. Reused by the three no-op branches
 *  inside the main compact path (ratio=0, target=0, dropped=0). Keeps the
 *  branch logic flat (drops `compact`'s cognitive complexity below biome's
 *  cap without changing semantics). */
const buildPassThrough = (
  messages: readonly { role: string; content: unknown }[],
  tokensBefore: number,
  now: () => number,
): MicroCompactResult => ({
  messages,
  turnsDropped: 0,
  turnsKept: messages.length,
  provenance: {
    reason: "microcompact",
    tokensBefore,
    tokensAfter: tokensBefore,
    turnsDropped: 0,
    turnsKept: messages.length,
    compactedAt: now(),
  },
})

/** Walk the droppable window [0, dropBoundary) and mark up to `target`
 *  indices for drop. System messages are skipped when `preserveSystem`.
 *  Returns the dropped flags + final dropped count. */
const selectDrops = (
  messages: readonly { role: string; content: unknown }[],
  dropBoundary: number,
  target: number,
  preserveSystem: boolean,
): { droppedFlags: boolean[]; dropped: number } => {
  const droppedFlags = new Array<boolean>(messages.length).fill(false)
  let dropped = 0
  for (let i = 0; i < dropBoundary && dropped < target; i++) {
    const m = messages[i]
    if (m === undefined) continue
    if (preserveSystem && m.role === "system") continue
    droppedFlags[i] = true
    dropped += 1
  }
  return { droppedFlags, dropped }
}

/** Normalize the resolved options for one `compact()` call. */
interface ResolvedOpts {
  readonly preserveSystem: boolean
  readonly preserveRecentTurns: number
  readonly dropRatio: number
  readonly tokensBefore: number
}

const resolveOpts = (input: MicroCompactInput): ResolvedOpts => ({
  preserveSystem: input.preserveSystem ?? true,
  preserveRecentTurns: Math.max(
    0,
    Math.floor(input.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT_TURNS),
  ),
  dropRatio: clamp(input.dropRatio ?? DEFAULT_DROP_RATIO, 0, 1),
  tokensBefore: input.tokenEstimate ?? estimateTokens(input.messages),
})

/** Assemble the post-drop result. Walks the dropped flags once to materialize
 *  the kept array, then stamps the provenance. Pure — no side effects. */
const assembleDropResult = (
  messages: readonly { role: string; content: unknown }[],
  droppedFlags: readonly boolean[],
  dropped: number,
  tokensBefore: number,
  tokenEstimateProvided: boolean,
  now: () => number,
): MicroCompactResult => {
  const kept: { role: string; content: unknown }[] = []
  for (let i = 0; i < messages.length; i++) {
    if (!droppedFlags[i]) {
      const m = messages[i]
      if (m !== undefined) kept.push(m)
    }
  }
  const tokensAfter = tokenEstimateProvided ? tokensBefore : estimateTokens(kept)
  return {
    messages: kept,
    turnsDropped: dropped,
    turnsKept: kept.length,
    provenance: {
      reason: "microcompact",
      tokensBefore,
      tokensAfter,
      turnsDropped: dropped,
      turnsKept: kept.length,
      compactedAt: now(),
    },
  }
}

export const createMicroCompactor = (opts?: MicroCompactorOpts): MicroCompactPort => {
  const now = opts?.now ?? Date.now
  return {
    compact(input) {
      if (!isWellFormed(input)) return buildNoOp(input, now)
      const messages = input.messages
      const total = messages.length
      const { preserveSystem, preserveRecentTurns, dropRatio, tokensBefore } = resolveOpts(input)
      if (total === 0 || dropRatio === 0 || preserveRecentTurns >= total) {
        return buildPassThrough(messages, tokensBefore, now)
      }
      const target = Math.floor(total * dropRatio)
      if (target === 0) return buildPassThrough(messages, tokensBefore, now)
      const dropBoundary = total - preserveRecentTurns
      const { droppedFlags, dropped } = selectDrops(messages, dropBoundary, target, preserveSystem)
      if (dropped === 0) return buildPassThrough(messages, tokensBefore, now)
      return assembleDropResult(
        messages,
        droppedFlags,
        dropped,
        tokensBefore,
        input.tokenEstimate !== undefined,
        now,
      )
    },
  }
}
