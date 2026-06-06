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
