/**
 * Line + body normalization for the moved-code matcher (ADR-0109).
 *
 * Defensive normalizations:
 *  - trailing whitespace stripped — refactor often touches trailing space
 *  - leading whitespace stripped — reindent should not change the move signal
 *  - blank lines dropped — `\n\n` insertion/removal does not change behavior
 *  - identifiers tokenized via `[A-Za-z0-9_]+` (word characters) — language-
 *    agnostic and language-independent, no AST dependency
 */

/** Normalize a single line: collapse leading/trailing whitespace. Returns
 *  `null` for lines that are entirely whitespace (caller drops them). */
export const normalizeLine = (line: string): string | null => {
  const trimmed = line.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** Normalize a hunk body: split by `\n`, drop blank lines, trim each. The
 *  output is the canonical form the matcher compares — `body` strings that
 *  normalize to the same array are matcher-equivalent regardless of
 *  whitespace / indent / blank-line shifts. */
export const normalizeLines = (body: string): readonly string[] => {
  const out: string[] = []
  for (const line of body.split("\n")) {
    const n = normalizeLine(line)
    if (n !== null) out.push(n)
  }
  return out
}

/** Identifier-level tokenizer. Splits on non-word characters; case-
 *  sensitive (a rename from `Foo` → `foo` IS a real change, not a move).
 *  Returns tokens in occurrence order (multiset semantics — duplicates kept). */
export const tokenize = (text: string): readonly string[] => {
  const matches = text.match(/[A-Za-z0-9_]+/g)
  return matches ?? []
}

/** Tokenize an entire normalized body for similarity comparison. Same as
 *  calling `tokenize` on the joined lines; pre-extracted as a seam so
 *  callers can swap in a different tokenizer without rippling. */
export const tokenizeBody = (lines: readonly string[]): readonly string[] =>
  tokenize(lines.join("\n"))
