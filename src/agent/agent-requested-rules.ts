/**
 * Agent-requested rules matcher (gap-other-agent GAP 6).
 *
 * Cursor's 4th rule type (`CursorRuleTypeAgentFetched`): a description-only rule
 * the model summons ON DEMAND via a `fetch_rules` tool (rather than auto-injected
 * by glob match). quanta's {@link tryLoadRule} DROPS rules that declare neither
 * `globs` nor `alwaysApply` — correct for the auto-inject path, but it means a
 * "fetch on demand" rule is invisible. This is the essential PURE matcher a
 * `fetch_rules` tool ranks those rules with; the loader (index description-only
 * rules instead of dropping) + the tool are the integration step.
 *
 * Deterministic — NO arbitrary fuzzy threshold (per the no-heuristics rule): the
 * score is the count of distinct, non-stopword query tokens present in the rule's
 * name+description; rules with score > 0 are returned, ranked by score desc then
 * name (stable), capped at `limit`. Pure + NO-THROW.
 */
import { byteCompare } from "@/shared"

/** A rule eligible for on-demand fetch (description-only / agent-requested). */
export interface RequestableRule {
  readonly name: string
  readonly description: string
  readonly body: string
}

/** A small, conventional stopword set so a query like "how to use the X" matches
 *  on X, not on the function words. Standard IR practice — not a tuned threshold. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "for",
  "and",
  "or",
  "is",
  "are",
  "be",
  "in",
  "on",
  "with",
  "how",
  "when",
  "what",
  "use",
  "using",
  "do",
  "i",
  "my",
  "this",
  "that",
  "it",
  "rule",
  "rules",
])

/** Lowercase → split on non-alphanumeric → drop short tokens + stopwords. */
const tokenize = (s: string): readonly string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))

/**
 * Rank {@link RequestableRule}s by token overlap with `query`. Returns only
 * rules sharing ≥1 query token, best-first, capped at `limit` (default 5).
 */
export const matchRulesByDescription = (
  query: string,
  rules: readonly RequestableRule[],
  limit = 5,
): readonly RequestableRule[] => {
  const q = new Set(tokenize(query))
  if (q.size === 0) return []
  const scored: { rule: RequestableRule; score: number }[] = []
  for (const rule of rules) {
    const hay = new Set([...tokenize(rule.name), ...tokenize(rule.description)])
    let score = 0
    for (const t of q) if (hay.has(t)) score++
    if (score > 0) scored.push({ rule, score })
  }
  // byteCompare (NOT localeCompare): a deterministic byte-order tie-break so the
  // ranked output is replay-stable across machines/ICU versions.
  scored.sort((a, b) => b.score - a.score || byteCompare(a.rule.name, b.rule.name))
  return scored.slice(0, Math.max(0, limit)).map((s) => s.rule)
}
