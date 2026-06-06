/** Surrogate-safe truncation.
 *
 * A JS string is UTF-16. A naive `s.slice(0, max)` at an arbitrary cap index can
 * cut a single astral code point (emoji / CJK-ext, encoded as a HIGH+LOW
 * surrogate PAIR) in HALF, leaving a LONE high surrogate at the end of the
 * result. A lone surrogate is not a valid Unicode scalar: it re-encodes to a
 * U+FFFD replacement char (or a malformed token) when the string is later
 * UTF-8-encoded for the wire / a prompt / a log.
 *
 * {@link sliceWholeChars} slices to AT MOST `max` UTF-16 code units without ever
 * splitting a surrogate pair: when the unit kept at `max - 1` is a HIGH
 * surrogate (its LOW half would land at index `max`, outside the slice), the cut
 * is backed off by one so the orphaned high surrogate is dropped instead.
 *
 * Guarantees:
 *  - result length ≤ `max`
 *  - result never ends in a lone high surrogate introduced by the cut
 *  - byte-identical to `s.slice(0, max)` whenever the input is under-cap, or when
 *    no surrogate pair straddles index `max`
 *
 * Pure; no dependencies.
 */
export const sliceWholeChars = (s: string, max: number): string => {
  if (max <= 0) return ""
  if (s.length <= max) return s
  const lastKept = s.charCodeAt(max - 1)
  // High surrogate range U+D800–U+DBFF. If the final kept unit is a high
  // surrogate, its low half lies at index `max` (outside the slice) — back off.
  const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? max - 1 : max
  return s.slice(0, end)
}

/**
 * Surrogate-safe TAIL slice — keep AT MOST the last `keep` UTF-16 code units of
 * `s` without ever LEADING with a lone LOW surrogate.
 *
 * The mirror of {@link sliceWholeChars}: a naive `s.slice(s.length - keep)` can
 * start the result on the LOW half of a pair whose HIGH half was just dropped,
 * leaving a lone low surrogate at the FRONT of the result. When the first kept
 * unit (at `s.length - keep`) is a low surrogate (U+DC00–U+DFFF), the cut is
 * advanced by one so the orphaned low half is dropped instead.
 *
 * Used by head+tail truncators (e.g. the PTY read-cap) where the START of the
 * tail segment is an arbitrary cut point.
 *
 * Guarantees:
 *  - result length ≤ `keep`
 *  - result never BEGINS with a lone low surrogate introduced by the cut
 *  - byte-identical to `s.slice(s.length - keep)` whenever the input is
 *    under-cap, or when no surrogate pair straddles the cut
 *
 * Pure; no dependencies.
 */
export const sliceTailWholeChars = (s: string, keep: number): string => {
  if (keep <= 0) return ""
  if (s.length <= keep) return s
  const start = s.length - keep
  const first = s.charCodeAt(start)
  // Low surrogate range U+DC00–U+DFFF. If the first kept unit is a low
  // surrogate, its high half lies at `start - 1` (outside the slice) — skip it.
  return s.slice(first >= 0xdc00 && first <= 0xdfff ? start + 1 : start)
}
