/**
 * Effort classifier implementation (ADR-0417).
 *
 * Holds the session-accumulated state: the running highest-wins recommendation
 * level, the per-tool failure counters, and the signal log. Pure w.r.t. IO and
 * clock — purely a state machine fed by `onUserPrompt` / `onToolFailure`.
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
  const signals: EscalationSignal[] = []
  const failureCounts = new Map<string, number>()

  const fold = (fresh: readonly EscalationSignal[]): void => {
    for (const sig of fresh) {
      signals.push(sig)
      level = maxLevel(level, sig.suggestedLevel)
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
      failureCounts.set(key, next)
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
