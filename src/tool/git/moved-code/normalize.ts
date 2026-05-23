/**
 * Line normalization for moved-code detection (ADR-0109 §결정).
 *
 * Two consumers:
 *   - `normalizeBody(body)` — used for similarity comparison + the `body` field
 *     stored on a {@link MovedBlock}. Strips leading/trailing whitespace,
 *     collapses internal runs of whitespace, drops fully-blank lines.
 *   - `tokenize(body)` — used by the Jaccard similarity scorer. Splits the
 *     normalized body on whitespace into a multiset of tokens.
 *
 * Pure functions — no I/O, no globals. NORMALIZATION IS LOSSY BY DESIGN:
 * indentation changes / trailing-whitespace fixes / blank-line insertions
 * collapse to the same canonical form, which is exactly what makes a "moved"
 * detection robust against reformat-on-move.
 */

/** Split body into lines, drop blank-after-trim, normalize internal whitespace. */
export const normalizeLines = (body: string): string[] => {
  if (body.length === 0) return []
  const lines = body.split("\n")
  const out: string[] = []
  for (const raw of lines) {
    // Trim + collapse interior runs of \s to a single space.
    const trimmed = raw.trim().replace(/\s+/g, " ")
    if (trimmed.length === 0) continue
    out.push(trimmed)
  }
  return out
}

/** Re-join normalized lines with `\n` — the canonical body form. */
export const normalizeBody = (body: string): string => normalizeLines(body).join("\n")

/**
 * Tokenize for Jaccard. We split on ANY non-identifier character (the
 * "word-character" class `[A-Za-z0-9_]`). This is the canonical token model
 * used by most code-clone detectors and by `git diff --word-diff=porcelain`'s
 * default regex — it treats `tally.total` as 2 tokens (`tally`, `total`),
 * which is what makes a single-identifier rename (HELL-14) still score
 * above the 0.85 floor for a 5-line block.
 *
 * Pure-punctuation runs do not survive (they are dropped along with the
 * whitespace), which is intentional: punctuation is usually shared between
 * any two non-trivially-different blocks and would inflate similarity if
 * kept as tokens.
 */
export const tokenize = (body: string): string[] => {
  const norm = normalizeLines(body).join(" ")
  if (norm.length === 0) return []
  // Match runs of word characters. `g` flag returns all matches.
  return norm.match(/[A-Za-z0-9_]+/g) ?? []
}
