/**
 * Exception / error type extraction from issue text — WITH verbatim message.
 *
 * We match exactly three trailing-suffix patterns (the dominant naming
 * conventions across SWE-bench's Python/TS/JS corpus):
 *
 *   - `…Error`     — TypeError, ValueError, UnicodeError, ConnectionError
 *   - `…Exception` — InvalidException, FlaskException
 *   - `…Warning`   — DeprecationWarning, FutureWarning
 *
 * The leading char must be uppercase (PascalCase convention). The bare words
 * `Error`/`Exception`/`Warning` are rejected — they're too common in prose
 * ("an error occurred").
 *
 * Verbatim-message policy (per user spec):
 *   - When a colon-prefixed message follows the type (`UnicodeError: encoding
 *     with 'idna' codec failed`), the tail through the next newline IS retained
 *     verbatim. Output: `"UnicodeError: encoding with 'idna' codec failed"`.
 *   - When no colon-message follows, output is the bare type: `"TypeError"`.
 *   - Message tail capped at MAX_MSG_LEN (256 chars) AFTER the colon — this
 *     covers idiomatic exception messages without letting a pathological
 *     "TypeError: <100KB of inline text>" balloon the hint.
 *
 * Sort order: lexicographic on the full string. So `Error` < `Error: msg`,
 * and message-bearing entries sort distinctly from bare types.
 *
 * Hardening: identifier length cap (60 chars), prototype-pollution rejection,
 * ANSI strip (terminal-output paste safety), dedup + sort for byte-stable
 * output.
 */
import { stripAnsi } from "./normalize"

const RESERVED = new Set(["__proto__", "constructor", "prototype"])
const MAX_TYPE_LEN = 60
const MAX_MSG_LEN = 256

/** A capital letter followed by ≥1 word chars, then the suffix. Capture group
 *  1 is the type; group 2 (optional) is the message body (colon + tail). The
 *  tail accepts everything up to newline. */
const ERROR_RE = /\b([A-Z][\w]*(?:Error|Exception|Warning))\b(\s*:\s*([^\n]+))?/g

/** Bare-suffix forms we reject (lookahead awkward in a single regex). */
const BARE = new Set(["Error", "Exception", "Warning"])

/** True ⇒ this match is rejected (bare suffix, prototype-pollution, or
 *  length out of bounds). */
const isRejected = (type: string): boolean => {
  if (type.length === 0 || type.length > MAX_TYPE_LEN) return true
  if (BARE.has(type)) return true
  if (RESERVED.has(type)) return true
  return false
}

/** Format the matched type with optional verbatim message tail. Returns the
 *  bare type when the tail is missing / empty after trim. */
const formatEntry = (type: string, tail: string | undefined): string => {
  if (typeof tail !== "string" || tail.length === 0) return type
  const trimmed = tail.replace(/\s+$/g, "")
  if (trimmed.length === 0) return type
  const capped = trimmed.length > MAX_MSG_LEN ? trimmed.slice(0, MAX_MSG_LEN) : trimmed
  return `${type}: ${capped}`
}

export const extractErrors = (text: string): readonly string[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const found = new Set<string>()
  ERROR_RE.lastIndex = 0
  for (const m of cleaned.matchAll(ERROR_RE)) {
    const type = m[1]
    if (typeof type !== "string") continue
    if (isRejected(type)) continue
    found.add(formatEntry(type, m[3]))
  }
  return Array.from(found).sort()
}
