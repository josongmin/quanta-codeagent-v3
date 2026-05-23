/**
 * Exception / error type extraction from issue text.
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
 * ("an error occurred"). We require at least one preceding capitalized or
 * lowercase character (i.e. minimum length 6 for `…Error`, 10 for `…Exception`,
 * 8 for `…Warning`).
 *
 * Hardening: identifier length cap (60 chars), prototype-pollution rejection,
 * ANSI strip (terminal-output paste safety), dedup + sort for byte-stable output.
 */
import { stripAnsi } from "./normalize"

const RESERVED = new Set(["__proto__", "constructor", "prototype"])
const MAX_LEN = 60

/** A capital letter followed by ≥1 word chars, then the suffix. Anchored at a
 *  word boundary so we don't capture mid-identifier substrings. */
const ERROR_RE = /\b([A-Z][\w]*(?:Error|Exception|Warning))\b/g

/** Bare-suffix forms we reject (the lookahead is awkward in a single regex,
 *  so we do a post-filter check). */
const BARE = new Set(["Error", "Exception", "Warning"])

export const extractErrors = (text: string): readonly string[] => {
  if (typeof text !== "string" || text === "") return []
  const cleaned = stripAnsi(text)
  const found = new Set<string>()
  ERROR_RE.lastIndex = 0
  for (const m of cleaned.matchAll(ERROR_RE)) {
    const raw = m[1]
    if (typeof raw !== "string") continue
    if (raw.length === 0 || raw.length > MAX_LEN) continue
    if (BARE.has(raw)) continue
    if (RESERVED.has(raw)) continue
    found.add(raw)
  }
  return Array.from(found).sort()
}
