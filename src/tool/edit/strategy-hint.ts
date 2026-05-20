/**
 * Phase 4 SOTA++ absorption — edit-strategy hints. Codex's edit-strategy state
 * machine (`agent-loop-deep-dive.md §7`, `tool-routing-and-triggering.md`)
 * teaches the model to SWITCH strategies on patch-context mismatch instead of
 * spinning on the same patch. We surface a structured `nextStrategy` plus a
 * one-line suggestion as a suffix on the existing error message — exit
 * semantics are unchanged (still ok:false); only the text grows.
 */

/** Next-strategy categories the LLM can route on:
 *   - `scripted_replace` — duplicated blocks / bulk substitution.
 *   - `read_then_patch`  — context drift; re-read the current span first.
 *   - `ambiguous`        — neither path is obviously better; surface a hedged
 *                          suggestion (LLM decides). */
export type NextStrategy = "scripted_replace" | "read_then_patch" | "ambiguous"

/** Stable structural marker so callers/tests can parse-spot the hint without
 *  pattern-matching a free-form sentence. */
export const STRATEGY_HINT_PREFIX = "Strategy hint:"

/** Classify why a patch attempt failed by inspecting the failure message text.
 *  Pure: case-folded substring checks against the messages produced by
 *  `applyExactEdit` / `applyFuzzyEdit`. Conservative — falls back to
 *  `ambiguous` so we always emit *some* hint on every failure. */
export const classifyMismatch = (message: string): NextStrategy => {
  const m = message.toLowerCase()
  // Multiple matches (exact "not unique" OR fuzzy "matched N spans; ambiguous")
  // ⇒ duplication is the symptom; scripted_replace is purpose-built for it.
  if (m.includes("not unique") || m.includes("ambiguous")) return "scripted_replace"
  // No match at all (exact "not found", fuzzy "no confident match") ⇒ context
  // drifted out from under the patch; re-reading is the right next step.
  if (m.includes("not found") || m.includes("no confident match")) return "read_then_patch"
  return "ambiguous"
}

/** One-line operator hint, prefixed with {@link STRATEGY_HINT_PREFIX} so the
 *  block is greppable in transcripts and tests. */
export const formatStrategyHint = (next: NextStrategy): string => {
  switch (next) {
    case "scripted_replace":
      return `${STRATEGY_HINT_PREFIX} this file's context is unstable for patch (duplicate / ambiguous match) — consider \`scripted_replace\` (bulk substitution) or add disambiguating context. nextStrategy: scripted_replace`
    case "read_then_patch":
      return `${STRATEGY_HINT_PREFIX} the surrounding context appears to have drifted — read the current span first and re-patch with the fresh context. nextStrategy: read_then_patch`
    case "ambiguous":
      return `${STRATEGY_HINT_PREFIX} switch strategies instead of re-trying the same patch — either \`scripted_replace\` (bulk substitution) or read the file then re-patch with fresh context. nextStrategy: ambiguous`
  }
}
