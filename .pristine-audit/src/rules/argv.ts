/**
 * §10.2 — argv tokenizer + array-literal parser + token-prefix matcher.
 *
 * Codex's `~/.codex/rules/default.rules` matches against the command's ARGV
 * TOKEN VECTOR via `prefix_rule(pattern=["git", "push"], decision="allow")`.
 * The pattern is a token PREFIX of the command argv — each pattern token must
 * equal the corresponding command token. This is strictly stronger than
 * byte-prefix matching: a token rule for `["git","push"]` never matches
 * `git push-mirror` (partial token) and never matches a SHORTER command argv.
 *
 * This module provides three PURE, NO-THROW, deterministic helpers:
 *
 *   - {@link tokenizeArgv}  — split a command STRING into argv tokens
 *     (POSIX-ish: whitespace separates; single/double quotes group;
 *     backslash escapes outside single-quotes). NOT a full shell parser —
 *     no expansion, no operators. Malformed input degrades best-effort,
 *     never throws.
 *   - {@link parseArgvArrayLiteral} — parse a rule-side `[...]` token array
 *     (`["git", "push"]` or `[git, push]`) into a `string[]`. Returns `null`
 *     for malformed / empty arrays (the caller raises `RuleParseError`).
 *   - {@link matchArgvRule} — token-prefix match a pattern token vector
 *     against a command's argv. The LAST pattern token may end with `*`
 *     (glob suffix, Codex parity); non-last tokens are matched literally.
 *
 * Determinism: no clock, no I/O, no global state. Every function is a total
 * function of its inputs.
 */

/** Quote / escape state used by {@link tokenizeArgv}. */
type QuoteState = "none" | "single" | "double"

/**
 * Split a shell command STRING into its argv token vector. POSIX-ish word
 * splitting (a deliberately small, auditable subset):
 *
 *   - Unquoted whitespace (space / tab) separates tokens; runs collapse.
 *   - `'single quotes'` group verbatim (backslash is literal inside).
 *   - `"double quotes"` group; backslash escapes the next char.
 *   - Outside quotes, `\` escapes the next char (so `file\ name` is one token).
 *   - Adjacent quoted + unquoted segments fuse into ONE token (`a"b"c`).
 *
 * NO-THROW: a non-string input yields `[]`; an unterminated quote consumes to
 * end-of-string (best-effort) rather than throwing. This is a MATCHING aid,
 * not a security boundary — the byte-prefix matcher remains the conservative
 * fallback for anything the tokenizer can't cleanly split.
 */
export const tokenizeArgv = (command: unknown): readonly string[] => {
  if (typeof command !== "string" || command.length === 0) return []

  const tokens: string[] = []
  let current = ""
  let hasToken = false // distinguishes "" (empty quoted token) from "no token"
  let state: QuoteState = "none"

  const flush = (): void => {
    if (hasToken) {
      tokens.push(current)
      current = ""
      hasToken = false
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? ""
    if (state === "single") {
      if (ch === "'") {
        state = "none"
      } else {
        current += ch
        hasToken = true
      }
      continue
    }
    if (state === "double") {
      if (ch === '"') {
        state = "none"
      } else if (ch === "\\") {
        // Backslash escapes the next char inside double quotes.
        const next = command[i + 1]
        if (next === undefined) {
          current += "\\"
          hasToken = true
        } else {
          current += next
          hasToken = true
          i++
        }
      } else {
        current += ch
        hasToken = true
      }
      continue
    }
    // state === "none"
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      flush()
      continue
    }
    if (ch === "'") {
      state = "single"
      hasToken = true
      continue
    }
    if (ch === '"') {
      state = "double"
      hasToken = true
      continue
    }
    if (ch === "\\") {
      const next = command[i + 1]
      if (next === undefined) {
        // Trailing backslash with no escape target: literal.
        current += "\\"
        hasToken = true
      } else {
        current += next
        hasToken = true
        i++
      }
      continue
    }
    current += ch
    hasToken = true
  }
  // Unterminated quote / final token: flush whatever we accumulated.
  flush()
  return tokens
}

/**
 * Parse a rule-side bracketed token array (`["git", "push"]` or `[git, push]`)
 * into a `string[]`. Both quoted (single / double) and bare tokens are
 * accepted; commas separate; surrounding whitespace is stripped.
 *
 * Returns `null` when:
 *   - the body is not bracket-delimited (`[` … `]`),
 *   - the bracket is unterminated,
 *   - the array is empty (`[]`),
 *   - any token is empty after trimming (e.g. trailing comma `[a,]`).
 *
 * The caller (`parseRules`) converts a `null` into a `RuleParseError` so the
 * "no silent fallback" invariant holds — a malformed array is never quietly
 * downgraded to a byte-prefix rule.
 */
export const parseArgvArrayLiteral = (body: string): readonly string[] | null => {
  const trimmed = body.trim()
  if (trimmed.length < 2) return null
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null
  const inner = trimmed.slice(1, -1).trim()
  if (inner.length === 0) return null // empty array

  const tokens: string[] = []
  let i = 0
  while (i < inner.length) {
    // Skip leading whitespace before a token.
    while (i < inner.length && isSpace(inner[i] ?? "")) i++
    if (i >= inner.length) break
    const ch = inner[i] ?? ""
    let token: string
    if (ch === '"' || ch === "'") {
      const parsed = readQuoted(inner, i, ch)
      if (parsed === null) return null // unterminated quote
      token = parsed.value
      i = parsed.next
    } else {
      const parsed = readBare(inner, i)
      token = parsed.value
      i = parsed.next
    }
    if (token.length === 0) return null
    tokens.push(token)
    // Skip whitespace, then require a comma or end.
    while (i < inner.length && isSpace(inner[i] ?? "")) i++
    if (i < inner.length) {
      if (inner[i] !== ",") return null // malformed separator
      i++ // consume comma
      // A trailing comma (`[a,]`) leaves only whitespace ⇒ caught as empty token.
      const rest = inner.slice(i).trim()
      if (rest.length === 0) return null
    }
  }
  return tokens.length > 0 ? tokens : null
}

const isSpace = (c: string): boolean => c === " " || c === "\t"

/** Read a quoted token starting at `start` (the opening quote). Returns the
 *  unquoted value + the index just past the closing quote, or `null` if
 *  unterminated. Backslash escapes inside double quotes only. */
const readQuoted = (
  s: string,
  start: number,
  quote: string,
): { value: string; next: number } | null => {
  let value = ""
  let i = start + 1
  while (i < s.length) {
    const ch = s[i] ?? ""
    if (ch === quote) {
      return { value, next: i + 1 }
    }
    if (quote === '"' && ch === "\\") {
      const next = s[i + 1]
      if (next !== undefined) {
        value += next
        i += 2
        continue
      }
    }
    value += ch
    i++
  }
  return null // unterminated
}

/** Read a bare (unquoted) token until a comma or whitespace. */
const readBare = (s: string, start: number): { value: string; next: number } => {
  let i = start
  while (i < s.length) {
    const ch = s[i] ?? ""
    if (ch === "," || isSpace(ch)) break
    i++
  }
  return { value: s.slice(start, i), next: i }
}

/**
 * Token-prefix match: is `pattern` a token prefix of `commandArgv`?
 *
 *   - `pattern` MUST be no longer than `commandArgv`.
 *   - tokens 0..n-2 match LITERALLY (`pattern[k] === commandArgv[k]`).
 *   - the LAST pattern token may end with `*` (Codex glob parity): a trailing
 *     `*` is a literal-prefix glob (`/repo/docs/*` matches
 *     `/repo/docs/readme.md`). Without a `*` it matches literally.
 *
 * Pure, NO-THROW. An empty pattern never matches (the parser rejects empty
 * arrays, so this is defensive).
 */
export const matchArgvRule = (
  pattern: readonly string[],
  commandArgv: readonly string[],
): boolean => {
  if (pattern.length === 0) return false
  if (pattern.length > commandArgv.length) return false
  const lastIdx = pattern.length - 1
  for (let k = 0; k < pattern.length; k++) {
    const p = pattern[k] ?? ""
    const c = commandArgv[k] ?? ""
    if (k === lastIdx && p.endsWith("*")) {
      const litPrefix = p.slice(0, -1)
      if (!c.startsWith(litPrefix)) return false
    } else if (p !== c) {
      return false
    }
  }
  return true
}
