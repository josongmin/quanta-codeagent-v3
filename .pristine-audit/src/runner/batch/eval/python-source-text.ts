/**
 * Shared Python-source text utilities for the bench eval signals.
 *
 * Hoisted from `declared-expected-matcher` and `verification-owner-test-expectations`,
 * which both mine literals from added/existing Python lines and must NOT let a stale
 * message parked in a comment leak into the mined literal (false-steer / false-veto).
 */

/**
 * Truncate a line at the first `#` that is OUTSIDE a string literal, removing any
 * trailing (or whole-line) Python comment. String-aware so a `#` inside a literal
 * (e.g. `"color #fff"`) is preserved; backslash-escapes inside the string are
 * honoured so `"a\"# b"` does not terminate the literal early.
 */
export const stripInlineComment = (line: string): string => {
  let q: string | undefined
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (q !== undefined) {
      if (c === "\\") {
        i += 1
        continue
      }
      if (c === q) q = undefined
      continue
    }
    if (c === '"' || c === "'") q = c
    else if (c === "#") return line.slice(0, i)
  }
  return line
}
