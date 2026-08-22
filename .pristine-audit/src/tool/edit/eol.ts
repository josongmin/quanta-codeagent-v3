/**
 * EOL (end-of-line) detection for EOL-aware fuzzy splicing (RFC jun-7 §3.1 / D6).
 *
 * The fuzzy edit ladder compares lines after stripping `\r` (via `.trim()` and
 * `/\r?\n/` split), so a CRLF file's `"foo\r"` matches a needle `"foo"`. When the
 * matched window is spliced back the replacement must be re-emitted with the
 * file's native terminator — otherwise the edited region silently becomes LF
 * while its neighbours stay CRLF (mixed-EOL corruption). This leaf is the single
 * owner of "what terminator does this source use".
 */

/** The two terminators we preserve. We do NOT model lone-CR (classic Mac); it is
 *  effectively extinct in source files and the split regex below treats a bare
 *  `\r` as part of the line, not a terminator. */
export type EolStyle = "\n" | "\r\n"

/**
 * Detect a source's dominant EOL terminator.
 *
 * Counts `\r\n` occurrences vs lone `\n` (an `\n` NOT preceded by `\r`). The
 * style is `\r\n` iff CRLF terminators are the STRICT majority of all line
 * terminators; ties and LF-majority resolve to `\n`. An empty / single-line
 * source (no terminator) defaults to `\n`. This is a pure measurement — an
 * integer comparison of observable terminator counts, no tunable threshold.
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
