/**
 * Prompt-suggestion slice — output sanitizer (ADR-0467).
 *
 * WHAT: `sanitizeSuggestion(raw) → string`. The SUGGESTION-MODE model is asked
 *   to emit `<suggestion>…</suggestion>`, but models leak: they wrap output in
 *   the tag inconsistently, prepend a "Suggestion:" label, or surround it with
 *   stray quotes/backticks. This strips that wrapper noise so the pure reject
 *   gate sees the bare candidate. Sanitize-then-gate is the pipeline order.
 *
 * SLICE: `@/agent`. Imports nothing (pure string). No `@/shared` needed.
 *
 * NO-THROW CONTRACT: total over every string; never throws. Worst case returns
 *   "" (which the reject gate then rejects as `empty`).
 *
 * EVIDENCE: Claude CLI strips its wrapper tag + leading label before the GZ8
 *   gate runs, transcribed 1:1 from `.extracted_source/claude-code-cli/`:
 *     tag:   `^<(suggestion|response|output|answer|result)>([\s\S]*)<\/\1>$`
 *     label: `^\s*(suggested\s+(response|reply|input|prompt)|suggestion|
 *             response|reply|answer|output|result)\s*:\s*`
 *   The competitor matches FIVE wrapper-tag names (not just `<suggestion>`) and
 *   a CLOSED label-word set (not any leading word). We mirror both verbatim; the
 *   gate's own `prefixed_label` predicate still catches any label we miss.
 */

/** Wrapper-tag names the model wraps output in. Verbatim from the competitor
 *  tag regex's alternation `(suggestion|response|output|answer|result)`. */
const TAG_NAMES = "suggestion|response|output|answer|result"

/** Matches a leading/trailing wrapper tag (any case, optional whitespace).
 *  The competitor's single regex requires a MATCHED pair via backreference;
 *  we strip each side independently so a model that leaks only the open or only
 *  the close tag is still cleaned (a strict superset that never mis-strips). */
const OPEN_TAG_RE = new RegExp(`^\\s*<\\s*(?:${TAG_NAMES})\\s*>\\s*`, "i")
const CLOSE_TAG_RE = new RegExp(`\\s*<\\s*/\\s*(?:${TAG_NAMES})\\s*>\\s*$`, "i")

/** Upper bound on nested wrapper-tag layers we peel. Models occasionally
 *  double- or triple-wrap (`<suggestion><suggestion>…</suggestion></suggestion>`);
 *  a single anchored strip would leave the inner tags as visible noise the gate
 *  cannot recognise. We peel up to this many layers, then stop — a NAMED bound
 *  (not a magic number) so a pathological input cannot drive unbounded work. */
const MAX_TAG_LAYERS = 4

/** A leading wrapper label the SUGGESTION-MODE prompt sometimes produces
 *  ("Suggestion:", "Response:", "Suggested reply:"). CLOSED set, transcribed
 *  1:1 from the competitor label regex — only these words (optionally
 *  `suggested response/reply/input/prompt`) followed by a colon are a wrapper
 *  label. Anything else (e.g. "Fix bug:") is left for the gate's
 *  `prefixed_label` predicate, so real content is never mangled. */
const LEADING_LABEL_RE =
  /^\s*(?:suggested\s+(?:response|reply|input|prompt)|suggestion|response|reply|answer|output|result)\s*:\s*/i

/** Matched paired surrounding quotes/backticks the model wraps a phrase in. */
const PAIRED_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
]

/**
 * Strip wrapper tags, a leading label, and matched surrounding quotes from a
 * raw model suggestion. Returns the bare candidate (trimmed). PURE & TOTAL.
 *
 * Order: tag-strip (up to {@link MAX_TAG_LAYERS} nested layers) → trim →
 * unwrap quotes → label-strip → final trim. The
 * label strip is intentionally conservative — it ONLY removes a short
 * `Label:` prefix; anything longer is left for the gate's `prefixed_label`
 * predicate to reject, so we never mangle real content that happens to contain
 * a colon mid-sentence.
 */
export function sanitizeSuggestion(raw: string): string {
  // Peel nested wrapper-tag layers up to a fixed bound. Each pass strips at
  // most one open + one close tag (both anchored to the string ends, so a tag
  // word appearing in the CONTENT is never touched). Stop early once a pass is
  // a no-op so we never iterate past the real nesting depth.
  let out = raw
  for (let layer = 0; layer < MAX_TAG_LAYERS; layer++) {
    const next = out.replace(OPEN_TAG_RE, "").replace(CLOSE_TAG_RE, "")
    if (next === out) break
    out = next
  }
  out = out.trim()

  // Unwrap a single layer of matched surrounding quotes/backticks.
  for (const [open, close] of PAIRED_WRAPPERS) {
    if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
      out = out.slice(open.length, out.length - close.length).trim()
      break
    }
  }

  // Strip a single short leading label ("Suggestion: …").
  out = out.replace(LEADING_LABEL_RE, "").trim()

  return out
}
