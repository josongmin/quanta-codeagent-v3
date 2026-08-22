/**
 * Pure NDJSON parser (ADR-0133 — text-format structured-data tools).
 *
 * Newline-delimited JSON: one JSON value per line, blank lines ignored.
 * Failure on a single line is captured per-line ({@link NdjsonLine.error})
 * — the parser NEVER throws. The whole-line `raw` string is preserved so a
 * caller (or the model) can render the original text.
 *
 * # Contract
 *
 *  1. **Pure.** No I/O. Input is a `string`, output is the typed
 *     {@link NdjsonParseResult}.
 *  2. **No-throw.** A malformed JSON line surfaces as `value: null` +
 *     `error: <message>`; only a non-string input throws.
 *  3. **exactOptionalPropertyTypes.** `error` is OMITTED when the line
 *     parsed successfully, never set to `undefined`.
 *  4. **Plane-clean.** Zero imports.
 */

/** One NDJSON line. `value` is the parsed JSON value on success, `null` on
 *  parse failure (in which case `error` is set). `raw` is the line text
 *  WITHOUT its terminator. */
export interface NdjsonLine<T = unknown> {
  readonly lineNumber: number
  readonly value: T | null
  readonly raw: string
  /** Error message from `JSON.parse` on failure. OMITTED (not `undefined`)
   *  under exactOptionalPropertyTypes when the line parsed successfully. */
  readonly error?: string
}

export interface NdjsonParseResult {
  readonly lines: ReadonlyArray<NdjsonLine>
  readonly errorCount: number
}

/** Thrown ONLY when the input is not a string. */
export class NdjsonParserInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NdjsonParserInputError"
  }
}

/** Parse a newline-delimited JSON string into per-line typed entries.
 *
 *  Pure. Never throws on malformed JSON (only on non-string input). */
export const parseNdjson = (source: string): NdjsonParseResult => {
  if (typeof source !== "string") {
    throw new NdjsonParserInputError(
      `parseNdjson expects a string, got ${source === null ? "null" : typeof source}`,
    )
  }
  if (source.length === 0) {
    return Object.freeze({ lines: Object.freeze([]), errorCount: 0 })
  }

  // Split on \n, then trim trailing \r so mixed CRLF/LF inputs work.
  const physical = source.split("\n")
  const lines: NdjsonLine[] = []
  let errorCount = 0
  for (let i = 0; i < physical.length; i++) {
    const rawWithCr = physical[i] ?? ""
    const raw = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr
    // Skip blank / whitespace-only lines (do NOT count toward errorCount).
    if (raw.trim() === "") continue
    const lineNumber = i + 1
    try {
      const value: unknown = JSON.parse(raw)
      lines.push(Object.freeze({ lineNumber, value, raw }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      errorCount++
      lines.push(Object.freeze({ lineNumber, value: null, raw, error: message }))
    }
  }
  return Object.freeze({ lines: Object.freeze(lines), errorCount })
}
