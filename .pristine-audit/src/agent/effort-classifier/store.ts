/**
 * Effort classifier implementation (ADR-0417).
 *
 * Holds the session-accumulated state: the running highest-wins recommendation
 * level, the per-tool failure counters, and the signal log. Pure w.r.t. IO and
 * clock — purely a state machine fed by `onUserPrompt` / `onToolFailure`.
 *
 * Bounded growth (R3 audit-M1 closeout). Previously the slice carried an
 * explicit `// UNBOUNDED:` opt-out that relied on compaction (default OFF)
 * to call `reset()` at the boundary. With compaction off the signal array
 * and failureCounts map grew per turn — a slow leak in long sessions and a
 * direct DoS surface under hostile prompt streams. Two structural caps act
 * as a compaction-independent backstop:
 *   - `signals` is a ring buffer (last `MAX_SIGNAL_RING` entries). Fold
 *     order is preserved within the window; older signals silently drop.
 *     `currentRecommendation().level` is unaffected because the running
 *     `level` is maintained INCREMENTALLY (highest-wins) and never
 *     recomputed from the array — eviction cannot downgrade the tier.
 *   - `failureCounts` is an LRU map (cap `MAX_FAILURE_COUNTS`, access-
 *     order). Threshold-trip semantics survive eviction because the running
 *     `level` is folded as soon as a counter reaches threshold — evicting
 *     a counter LATER cannot un-trip a signal that already promoted the
 *     recommendation.
 *
 * NO HEURISTICS — fixed integer caps, documented justification (see
 * `MAX_SIGNAL_RING` / `MAX_FAILURE_COUNTS` docstrings).
 */

import { DEFAULT_EFFORT, type EffortLevel } from "../effort"
import { DEFAULT_KEYWORD_RULES, detectKeywords, maxLevel } from "./keyword-detector"
import type {
  EffortClassifierOptions,
  EffortClassifierPort,
  EffortRecommendation,
  EscalationSignal,
  KeywordRule,
} from "./types"

const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_FAILURE_LEVEL: EffortLevel = "high"
/** Ring-buffer cap for the signal log. 1024 = ~one observation per turn
 *  across multiple hours of conversation before the oldest is evicted; the
 *  recommendation `level` is held INCREMENTALLY so eviction never downgrades
 *  the running tier (the audit-M1 justification). */
const MAX_SIGNAL_RING = 1024
/** LRU cap for the per-tool failure-counter map. 256 = ~16× the typical
 *  per-session distinct-tool count (the LLM rarely calls more than ~16 tools
 *  in a run); a hostile sequence proposing arbitrary tool names is bounded.
 *  Threshold-trip signals already fired remain in the running `level`. */
const MAX_FAILURE_COUNTS = 256

/** Clamp a caller-supplied threshold to a sane positive integer. A non-finite
 *  / non-positive value falls back to the default (NO-THROW posture). */
const normalizeThreshold = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return DEFAULT_FAILURE_THRESHOLD
  return Math.floor(raw)
}

const reasonFor = (level: EffortLevel, signals: readonly EscalationSignal[]): string => {
  if (signals.length === 0 || level === DEFAULT_EFFORT) return "no escalation signals"
  const last = signals[signals.length - 1]
  if (last?.kind === "keyword") return `keyword "${last.matched}" → ${level}`
  if (last?.kind === "tool_failure_accumulation") {
    return `${last.tool} failed ${last.failureCount}× → ${level}`
  }
  return `escalated to ${level}`
}

/**
 * Construct an {@link EffortClassifierPort}. Each instance owns its own state
 * (no shared module-level mutable) so concurrent sessions / tests do not leak.
 */
export const createEffortClassifier = (opts?: EffortClassifierOptions): EffortClassifierPort => {
  const rules: readonly KeywordRule[] =
    opts?.keywordRules !== undefined ? opts.keywordRules : DEFAULT_KEYWORD_RULES
  const threshold = normalizeThreshold(opts?.failureThreshold)
  const failureLevel: EffortLevel = opts?.failureLevel ?? DEFAULT_FAILURE_LEVEL

  let level: EffortLevel = DEFAULT_EFFORT
  /** Ring buffer (cap `MAX_SIGNAL_RING`). Append amortised O(1) via a single
   *  shift past the cap — at this size the per-turn cost is negligible vs
   *  the cap of one fold per signal. Eviction is silent — the running `level`
   *  is incrementally folded so the recommendation tier cannot regress. */
  const signals: EscalationSignal[] = []
  /** LRU map (cap `MAX_FAILURE_COUNTS`). Access-order via delete+set on each
   *  hit so `Map`'s insertion-order iteration becomes recency order; the
   *  first key on eviction is the LEAST-recently used. */
  const failureCounts = new Map<string, number>()

  const fold = (fresh: readonly EscalationSignal[]): void => {
    for (const sig of fresh) {
      signals.push(sig)
      // Ring buffer eviction: keep the running `level` first (already folded
      // ABOVE this guard), so dropping the oldest signal cannot downgrade.
      if (signals.length > MAX_SIGNAL_RING) signals.shift()
      level = maxLevel(level, sig.suggestedLevel)
    }
  }

  /** Read-then-bump access order: delete the existing key and re-set so the
   *  map's insertion-order iteration tracks recency. NO-OP on a fresh insert
   *  (handled by the caller). */
  const touchFailureKey = (key: string, value: number): void => {
    if (failureCounts.has(key)) failureCounts.delete(key)
    failureCounts.set(key, value)
    // LRU eviction: drop the least-recently used (first iterated) until cap.
    while (failureCounts.size > MAX_FAILURE_COUNTS) {
      const oldest = failureCounts.keys().next().value
      if (oldest === undefined) break
      failureCounts.delete(oldest)
    }
  }

  return {
    onUserPrompt(text: string): readonly EscalationSignal[] {
      const fresh = detectKeywords(text, rules)
      fold(fresh)
      return fresh
    },
    onToolFailure(toolName: string): readonly EscalationSignal[] {
      const key = typeof toolName === "string" ? toolName : ""
      const next = (failureCounts.get(key) ?? 0) + 1
      // Bump recency on this key + bound the map; replaces the bare `set`
      // call so an unbounded hostile sequence (each call with a fresh tool
      // name) cannot push the map past `MAX_FAILURE_COUNTS`.
      touchFailureKey(key, next)
      // Fire exactly once, at the moment the count reaches the threshold —
      // not on every subsequent failure (avoids signal-log thrash).
      if (next !== threshold) return []
      const sig: EscalationSignal = {
        kind: "tool_failure_accumulation",
        tool: key,
        failureCount: next,
        suggestedLevel: failureLevel,
      }
      fold([sig])
      return [sig]
    },
    currentRecommendation(): EffortRecommendation {
      return {
        level,
        signals: [...signals],
        reason: reasonFor(level, signals),
      }
    },
    reset(): void {
      level = DEFAULT_EFFORT
      signals.length = 0
      failureCounts.clear()
    },
  }
}
