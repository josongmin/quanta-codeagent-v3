/**
 * Keyword detection + tier ordering (ADR-0417).
 *
 * Pure helpers — no state. The default rule set mirrors the prompt-keyword
 * escalation vocabulary used by Claude/Codex ("ultrathink" / "think harder"
 * → max; "think hard" / "deeper" / "be thorough" → high). Highest-wins
 * ordering is encoded by {@link EFFORT_INTENSITY}.
 */

import type { EffortLevel } from "../effort"
import type { EscalationSignal, KeywordRule } from "./types"

/**
 * Intensity rank for the highest-wins collapse. `default` is the floor (0);
 * `max` is the ceiling. Ordering: `max > high > medium > low > default`.
 * Kept as an exhaustive Record so adding an EffortLevel literal without a
 * rank is a compile error.
 */
export const EFFORT_INTENSITY: Record<EffortLevel, number> = {
  default: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
}

/** Default keyword rules. Order is irrelevant — collapse is by intensity.
 *
 *  Audit R2 (F5): word-boundary anchors (`\b`) on every keyword block false
 *  positives in identifiers (`myUltrathinkVariable`), paths (`/path/ultrathink-
 *  dir`), and concatenated tokens. Each keyword is a multi-word ALT inside a
 *  non-capturing group so `\b` brackets the entire phrase verbatim. The
 *  inside-code-block / inside-quotes false positive remains by design — the
 *  detector is a token-level signal, not a markdown parser, and tagging it as
 *  signal-only (escalate-floor, never de-escalate, per session-state docstring)
 *  bounds the blast radius of any residual false positive to a single session's
 *  token budget. */
export const DEFAULT_KEYWORD_RULES: readonly KeywordRule[] = [
  { pattern: /\b(?:ultrathink|think harder)\b/i, level: "max" },
  { pattern: /\b(?:think hard|deeper)\b/i, level: "high" },
  { pattern: /\bbe thorough\b/i, level: "high" },
]

/** The higher-intensity of two tiers (highest-wins). */
export const maxLevel = (a: EffortLevel, b: EffortLevel): EffortLevel =>
  EFFORT_INTENSITY[a] >= EFFORT_INTENSITY[b] ? a : b

/**
 * Scan `text` against `rules`, emitting one `keyword` signal per matching
 * rule. NO-THROW: a rule whose `.test()` throws (pathological RegExp) is
 * skipped rather than propagated. The `matched` field records the rule's
 * source pattern so a surface can show WHY effort was bumped.
 */
export const detectKeywords = (
  text: string,
  rules: readonly KeywordRule[],
): readonly EscalationSignal[] => {
  if (typeof text !== "string" || text.length === 0) return []
  const out: EscalationSignal[] = []
  for (const rule of rules) {
    let matched = false
    try {
      // RegExp may carry the global flag from a caller-supplied rule; reset
      // lastIndex defensively so repeated calls are stateless.
      rule.pattern.lastIndex = 0
      matched = rule.pattern.test(text)
    } catch {
      matched = false
    }
    if (matched) {
      out.push({ kind: "keyword", matched: rule.pattern.source, suggestedLevel: rule.level })
    }
  }
  return out
}
