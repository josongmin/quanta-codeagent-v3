/**
 * Expected/Actual phrase extraction — OPT-IN ONLY.
 *
 * Pattern matches sentence-bounded occurrences of `expected/actual/should/got/
 * but/instead`. False-positive-prone in prose ("we expected good results from
 * the meeting" — not an issue claim), so this extractor is gated separately
 * (`QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL=1`) and *never* runs in the default
 * hint path.
 *
 * Boundary policy:
 *   - sentence boundary preferred (`.` `?` `\n`) — emit through next terminator
 *   - 200-char hard cap as fallback when the matched sentence runs longer
 *   - leading/trailing whitespace trimmed; matched text otherwise verbatim
 *
 * NOT a substitute for the `## Expected Result` / `## Actual Result` markdown
 * sections common in GitHub issues — those are handled at the compose layer
 * by leaving the original problem statement untouched. This extractor only
 * fires when the author wrote inline natural-language phrasing.
 */
import { stripAnsi } from "./normalize"

const MAX_PHRASE_LEN = 200

/** Sentence-bounded match. Anchored on a keyword, capture up to next sentence
 *  terminator (`. ! ? newline`) or `MAX_PHRASE_LEN` chars, whichever first.
 *
 *  Keywords (word-boundary anchored, case-insensitive):
 *    - expected / expect
 *    - actual / actually
 *    - got
 *    - should
 *    - but
 *    - instead
 *
 *  Note: the `{0,200}` quantifier is greedy-with-bound — JS regex backtracking
 *  is bounded by the explicit length, so this is NOT a regex-DoS vector. */
const EA_RE =
  /\b(?:expected|actually|actual|expect|got|instead|should|but)\b[^.?!\n]{0,200}[.?!\n]/gi

export const extractExpectedActual = (text: string): readonly string[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const found = new Set<string>()
  EA_RE.lastIndex = 0
  for (const m of cleaned.matchAll(EA_RE)) {
    const raw = m[0]
    if (typeof raw !== "string") continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    // Defensive — phrase up to 200 chars of body + 1 terminator.
    if (trimmed.length > MAX_PHRASE_LEN + 1) continue
    found.add(trimmed)
  }
  // Preserve discovery order for human-readable output, with dedup applied
  // via the Set above. We DO NOT sort — the order of expected/actual phrases
  // is sometimes meaningful ("expected …; got …" reads naturally in order).
  return Array.from(found)
}
