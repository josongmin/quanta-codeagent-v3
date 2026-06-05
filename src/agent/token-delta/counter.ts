/**
 * Delta token accounting (RFC jun-6-delta-token-accounting §4).
 *
 * The loop estimates the conversation's context-token footprint by re-scanning
 * the ENTIRE working-memory transcript through `estimateTokens` at multiple
 * points per turn (RFC §3.2). The transcript is append-mostly: between turns
 * only a small tail changes (RFC §3.3). This counter memoizes the running
 * estimate incrementally — add the cost of appended messages, subtract the cost
 * of removed ones — so the loop reads `total()` in O(1) instead of re-scanning
 * in O(n).
 *
 * BYTE-IDENTITY (the load-bearing invariant, RFC §4.1, §8):
 *   `estimateTokens` applies `Math.ceil` ONCE over the TOTAL char count, not per
 *   message. So a naive `+= estimateTokens(added)` would drift by ≤1 token from
 *   a single full-scan ceil (ceil-of-sum ≠ sum-of-ceils). This counter therefore
 *   tracks the PRE-CEIL char total (via `charsOf`, the shared sum extracted from
 *   `estimateTokens`) and applies `ceil(chars/4)` only in `total()`. Because
 *   `charsOf` is a pure sum over independent per-block char counts,
 *   `charsOf(A) + charsOf(B) === charsOf(A ++ B)` EXACTLY, so the running total
 *   is PROVABLY equal to a full `estimateTokens(currentMessages)` at every step.
 *   It is a memoization of a pure function, not a behavior change.
 *
 * Pure arithmetic accumulator: no clock, no randomness, no env, no I/O. The
 * knob (`QUANTA_DELTA_TOKEN_COUNT`) guards CONSTRUCTION/perf at the composition
 * root — it does NOT change the arithmetic (the produced numbers are identical
 * ON or OFF). Default-OFF the loop never constructs the counter and calls
 * `estimateTokens` directly, byte-identical.
 */

import { charsOf, estimateTokens } from "@/agent/compaction"
import type { Message } from "@/llm"

export interface TokenDeltaCounter {
  /** O(1) — the running estimate, byte-identical to `estimateTokens(current)`. */
  total(): number
  /** Account newly-appended messages: `+= charsOf(added)`. */
  onAppend(added: readonly Message[]): void
  /** Account removed messages: `-= charsOf(removed)`, clamped at 0 (a corrupt-
   *  state guard — a reseed restores truth; RFC §6.1, §8 stale-counter). */
  onRemove(removed: readonly Message[]): void
  /** Full recompute = `charsOf(messages)`. Used at the only non-append events:
   *  compaction (prefix → summary) and fork (RFC §4.2). Self-heals any drift. */
  reseed(messages: readonly Message[]): void
}

/**
 * Construct a delta counter seeded from `initial`. The internal state is the
 * PRE-CEIL char total — `total()` applies the same single `Math.ceil(chars/4)`
 * that `estimateTokens` does, so the result is byte-identical to a full re-scan.
 */
export const createTokenDeltaCounter = (initial: readonly Message[]): TokenDeltaCounter => {
  let chars = charsOf(initial)
  return {
    // estimateTokens([]) === Math.ceil(0/4) === 0, and Math.ceil(chars/4) over
    // the running pre-ceil sum reproduces the single end-ceil exactly.
    total: () => Math.ceil(chars / 4),
    onAppend: (added) => {
      chars += charsOf(added)
    },
    onRemove: (removed) => {
      // Clamp at 0: removing more than is present (a tracking bug or a reseed-
      // less drop) must not produce a negative char total that would then
      // ceil-to-negative. A subsequent reseed restores the ground truth.
      chars = Math.max(0, chars - charsOf(removed))
    },
    reseed: (messages) => {
      chars = charsOf(messages)
    },
  }
}

// `estimateTokens` is re-exported solely so consumers verifying byte-identity
// against the counter import both from one place; the counter does not call it
// internally (it tracks the pre-ceil sum). Keeping the import live also pins the
// arithmetic contract: total() === estimateTokens(current).
export { estimateTokens }
