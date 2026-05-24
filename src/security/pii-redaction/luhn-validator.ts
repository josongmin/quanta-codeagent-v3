/**
 * Luhn checksum validator (ADR-0171).
 *
 * Filter for the credit-card regex hit. A 16-digit run could be an order ID,
 * a phone identifier concatenation, or a hashed prefix — the false-positive
 * class is too large to emit as a finding without a structural check. The
 * Luhn checksum (mod-10) is the documented validation for IINs and reduces
 * the FP rate to chance (~1 in 10 for random digits).
 *
 * Implementation notes:
 *
 *   - The caller is expected to strip spaces and dashes BEFORE calling
 *     {@link isLuhnValid}. The function itself is purely numeric: every char
 *     must be ASCII '0'..'9'. Non-digit input returns false (NOT throw —
 *     this is a defensive primitive, not a contract-asserting helper).
 *   - Right-to-left walk; doubles every second digit; sums digits of the
 *     doubled value (`d > 9 ? d - 9 : d`) which is equivalent to the
 *     canonical "sum of digits" rule for a number ≤ 18.
 *   - Pure / deterministic / no allocation. O(n) over the input length.
 */

/**
 * @param digits ASCII digit string with NO spaces or dashes.
 *               Caller MUST sanitize first.
 * @returns true iff the digit string passes the Luhn mod-10 checksum AND has
 *          length ≥ 2 (a single digit is degenerate — `0` would otherwise
 *          pass the checksum and report as a valid card).
 */
export const isLuhnValid = (digits: string): boolean => {
  if (digits.length < 2) return false
  let sum = 0
  let shouldDouble = false
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i)
    // ASCII '0' = 48, '9' = 57. Any non-digit -> not a card.
    if (code < 48 || code > 57) return false
    let d = code - 48
    if (shouldDouble) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    shouldDouble = !shouldDouble
  }
  return sum % 10 === 0
}
