/**
 * ADR-0131 — Preference phrase grammar parser.
 *
 * Extracts structured signal from the free-form "feedback" memory body
 * convention adopted in [[0131-memory-outcome-and-preference-grammar.md]] §2:
 *
 *   **When the user said** "코드 레벨로만"
 *   **They meant**: narrow to source/tests/gates, exclude docs
 *   **Evidence**: ../sessions/2026-05-23-...md L42-L51 (3 corrections same week)
 *   **Confidence**: high (3 repetitions) | medium (2) | low (1)
 *
 * This file is **pure** — no I/O, no clock, no LLM. Outputs are inputs to
 * later promotion/lint passes.
 *
 * Design discipline ([[no-heuristics-only-validated]]):
 *   - Quote extraction is **literal** (Korean + English preserved byte-for-byte).
 *   - Confidence is **count-based** (1 correction → low, 2 → medium, 3+ → high).
 *     No subjective scoring, no ML, no thresholds beyond the count derivative
 *     itself.
 *   - Patterns match a **lowercased + whitespace-normalized** view of the
 *     text but the **slices returned** are from the ORIGINAL string so
 *     non-ASCII / mixed-case quote bytes survive intact.
 */

/**
 * Structured signal extracted from a preference-style memory body.
 *
 * Every field is optional; a body that contains none of the conventional
 * markers returns `{}` (caller's job to decide whether that's a lint
 * warning, not the parser's).
 */
export interface PreferenceSignal {
  /**
   * Literal quote attributed to the user. Korean / English / mixed UTF-8
   * preserved byte-for-byte from the source text — never lowercased,
   * never trimmed (a literal trailing space inside the quote IS part of
   * the quote per the grammar contract).
   */
  readonly quote?: string
  /**
   * Free-form evidence locator. Convention is `file:line` (e.g.
   * `src/foo.ts:42`), URL (`https://...`), or commit SHA — the lint pass
   * enforces ONE of those shapes; the grammar parser only extracts the
   * raw string after the `Evidence:` marker.
   */
  readonly evidence?: string
  /**
   * Confidence level derived from the body. Sources, in priority order:
   *   1. Explicit `Confidence: high|medium|low` marker (literal match).
   *   2. Count derivative: `N corrections` (or `N repetitions`):
   *        N == 1 → 'low', N == 2 → 'medium', N >= 3 → 'high'.
   * If both are present, the explicit marker wins (author intent overrides
   * derivative). If neither is present, the field is absent.
   */
  readonly confidence?: "high" | "medium" | "low"
}

/**
 * Map a count of repetitions/corrections to a {@link PreferenceSignal.confidence}
 * level. Count-based per [[no-heuristics-only-validated]] (no subjective scoring).
 *
 * Boundary table:
 *   n <= 0 → undefined (not a valid count)
 *   n == 1 → 'low'
 *   n == 2 → 'medium'
 *   n >= 3 → 'high'
 */
const confidenceFromCount = (n: number): "high" | "medium" | "low" | undefined => {
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n === 1) return "low"
  if (n === 2) return "medium"
  return "high"
}

// ─── Pattern primitives ─────────────────────────────────────────────────
//
// All regexes operate on a NORMALIZED view of the text (lowercased,
// whitespace-collapsed) but capture INDICES we use to slice the ORIGINAL
// text — so Korean/case-sensitive quote content survives unchanged.

/**
 * Match the "When the user said" header followed by a quoted phrase.
 * The phrase delimiter may be one of:
 *   - Plain ASCII double quote:   "..."
 *   - Backtick:                   `...`
 *   - Curly typographic:          “...”
 *
 * `\s*` allows the header → quote spacing to be tabs/newlines/spaces.
 * The header itself is matched case-insensitively against the normalized
 * text; the captured group's INDICES are then used to slice the original.
 */
const QUOTE_HEADER_RE =
  /\*?\*?when\s+(?:the\s+user|they|user)\s+said\*?\*?[\s:]*[`"“]([^`"”]+)[`"”]/i

/**
 * Match `Evidence:` followed by free-form text up to end-of-line. The
 * line-bound capture deliberately stops at `\n` so a multi-line memory
 * body cannot pull subsequent paragraphs into the evidence string.
 */
const EVIDENCE_RE = /\*?\*?evidence\*?\*?\s*[:=]\s*([^\n]+)/i

/**
 * Explicit confidence marker. Captures the literal level word; the caller
 * verifies it is `high|medium|low` (other words are ignored — falls through
 * to count derivative).
 */
const EXPLICIT_CONFIDENCE_RE = /\*?\*?confidence\*?\*?\s*[:=]\s*(high|medium|low)\b/i

/**
 * Count derivative: `N corrections|repetitions|times`. Stops at word boundary
 * so `30 corrections` doesn't match `3` then `0 corrections`.
 */
const COUNT_DERIVATIVE_RE = /\b(\d{1,4})\s+(?:corrections?|repetitions?|times)\b/i

/**
 * Parse a preference-style memory body into a {@link PreferenceSignal}.
 *
 * Returns `{}` for a body with no recognizable markers (caller decides
 * whether absence is a lint warning). Never throws — invalid input
 * produces an empty signal rather than an exception, mirroring the
 * `RolloutTaintedError` parser-vs-detector boundary used elsewhere in
 * the consolidator slice.
 *
 * @param text The memory body (markdown), as authored. Caller has already
 *             stripped frontmatter if applicable; this parser does NOT
 *             reach into frontmatter to find quotes.
 */
/** Extract a non-empty trimmed group-1 capture from a regex against `text`,
 *  or undefined when the regex did not match / the capture is blank.
 *  Pulled out of {@link parsePreferenceSignal} to keep that function's
 *  cyclomatic complexity ≤15 (biome ratchet). */
const extractTrimmedGroup1 = (re: RegExp, text: string): string | undefined => {
  const m = re.exec(text)
  if (m === null || typeof m[1] !== "string") return undefined
  const trimmed = m[1].trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Pull a `confidence` level from `text` per ADR-0131 §2: explicit marker
 *  wins over count derivative. Returns undefined when neither applies. */
const resolveConfidence = (text: string): "high" | "medium" | "low" | undefined => {
  const cm = EXPLICIT_CONFIDENCE_RE.exec(text)
  if (cm !== null && typeof cm[1] === "string") {
    const lvl = cm[1].toLowerCase()
    if (lvl === "high" || lvl === "medium" || lvl === "low") return lvl
  }
  const nm = COUNT_DERIVATIVE_RE.exec(text)
  if (nm !== null && typeof nm[1] === "string") {
    return confidenceFromCount(Number.parseInt(nm[1], 10))
  }
  return undefined
}

export const parsePreferenceSignal = (text: string): PreferenceSignal => {
  if (typeof text !== "string" || text.length === 0) return {}

  // Each helper is independent (no cross-marker dependency) so the absence
  // of one marker never affects extraction of the others — matches the
  // ADR-0131 §2 contract.
  const quote = extractTrimmedGroup1(QUOTE_HEADER_RE, text)
  const evidence = extractTrimmedGroup1(EVIDENCE_RE, text)
  const confidence = resolveConfidence(text)

  // exactOptionalPropertyTypes: only spread keys whose value is defined,
  // so the resulting object's `hasOwn(...)` set matches the contract that
  // an absent marker yields an absent property (not `{ x: undefined }`).
  return {
    ...(quote !== undefined ? { quote } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  }
}
