/**
 * EOL (end-of-line) detection + EOL-aware line splitting/joining.
 *
 * SSOT for "what terminator does this source use" + how to split a source into
 * lines without leaking a trailing `\r` and how to re-join with the file's
 * native terminator. Both the V4A patch applier (`@/patch`) and the fuzzy edit
 * ladder (`@/tool/edit`) need identical EOL semantics: a parser / matcher that
 * compares lines after stripping `\r` will silently produce mixed-EOL output if
 * the splice re-emits LF on an otherwise-CRLF file.
 *
 * The `@/patch` slice MUST NOT import `@/tool/edit` (slice fence), so the
 * detection logic lives here in `@/shared` and BOTH slices import it. A parity
 * ratchet test (in tests, which may cross slices) asserts this module's
 * {@link detectEol} stays byte-for-byte equivalent to `@/tool/edit/eol`'s
 * `detectEol` so the two cannot drift.
 *
 * Reference: RFC jun-7 §3.1 / D6 (edit slice) + jun-8 longtail F1 (patch slice).
 */

/** The two terminators we preserve. We do NOT model lone-CR (classic Mac); it is
 *  effectively extinct in source files and {@link splitEolAware} treats a bare
 *  `\r` (not followed by `\n`) as part of the line, not a terminator. */
export type EolStyle = "\n" | "\r\n"

/**
 * Detect a source's dominant EOL terminator.
 *
 * Counts `\r\n` occurrences vs lone `\n` (an `\n` NOT preceded by `\r`). The
 * style is `\r\n` iff CRLF terminators are the STRICT majority of all line
 * terminators; ties and LF-majority resolve to `\n`. An empty / single-line
 * source (no terminator) defaults to `\n`. This is a pure measurement — an
 * integer comparison of observable terminator counts, no tunable threshold.
 *
 * Semantics are byte-identical to `@/tool/edit/eol`'s `detectEol` (parity
 * ratchet enforces this).
 */
export const detectEol = (source: string): EolStyle => {
  let crlf = 0
  let loneLf = 0
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a /* \n */) {
      if (i > 0 && source.charCodeAt(i - 1) === 0x0d /* \r */) crlf++
      else loneLf++
    }
  }
  // STRICT majority for CRLF: a tie keeps the LF default so we never *introduce*
  // CRLF into a file that wasn't already dominantly CRLF.
  return crlf > loneLf ? "\r\n" : "\n"
}

/**
 * Split a source into lines EOL-agnostically, dropping the terminator.
 *
 * Splits on `/\r?\n/` so a CRLF file's `"foo\r\n"` yields `"foo"` (no trailing
 * `\r`) — identical to the edit slice's compare-split. A bare `\r` not followed
 * by `\n` stays inside its line (lone-CR is not a terminator here). Lines are
 * returned WITHOUT terminators; rejoin with {@link joinWithEol}.
 */
export const splitEolAware = (source: string): string[] => source.split(/\r?\n/)

/** Re-join terminator-stripped lines with the given EOL style. The inverse of
 *  {@link splitEolAware} given the original {@link detectEol} style; no trailing
 *  terminator is appended (the caller owns trailing-newline policy). */
export const joinWithEol = (lines: string[], eol: EolStyle): string => lines.join(eol)
