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

/** Mutable scanner accumulator for {@link tokenizeArgv}. Its own type because
 *  the four scan variables move together — every state step reads and writes
 *  the same four, so passing them as one record keeps each step a real unit
 *  instead of a five-argument tuple shuffle. `hasToken` distinguishes `""`
 *  (an empty QUOTED token) from "no token started yet". */
interface Scan {
  readonly tokens: string[]
  current: string
  hasToken: boolean
  state: QuoteState
}

/** End the current token, if one was started. Its own unit because "started"
 *  is the `hasToken` flag, not `current.length` — an empty quoted token
 *  (`''`) must still be pushed. */
const flushToken = (s: Scan): void => {
  if (s.hasToken) {
    s.tokens.push(s.current)
    s.current = ""
    s.hasToken = false
  }
}

/** Append one literal char and mark a token as started. Spelled once here
 *  because the original repeated this exact pair in SEVEN places, and every
 *  repetition was a place the flag could be forgotten. */
const emit = (s: Scan, ch: string): void => {
  s.current += ch
  s.hasToken = true
}

/** The backslash rule, shared VERBATIM by the double-quoted and unquoted
 *  states (the original spelled it twice): the next char is taken literally,
 *  and a trailing backslash with no escape target is itself literal.
 *  Returns the number of EXTRA input chars consumed (1 when a target was
 *  eaten) so the caller advances the cursor identically in both states. */
const stepEscape = (s: Scan, next: string | undefined): number => {
  if (next === undefined) {
    emit(s, "\\")
    return 0
  }
  emit(s, next)
  return 1
}

/** Inside `'single quotes'`: only the closing quote is special — backslash is
 *  literal. */
const stepSingle = (s: Scan, ch: string): number => {
  if (ch === "'") s.state = "none"
  else emit(s, ch)
  return 0
}

/** Inside `"double quotes"`: the closing quote ends the group, backslash
 *  escapes, everything else is literal. */
const stepDouble = (s: Scan, ch: string, next: string | undefined): number => {
  if (ch === '"') {
    s.state = "none"
    return 0
  }
  if (ch === "\\") return stepEscape(s, next)
  emit(s, ch)
  return 0
}

/** Unquoted whitespace — the ONLY token separator. */
const isArgvSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r"

/** Opening quote char → the state it enters. A TABLE rather than a second
 *  if/else pair, so adding a quote flavour is a row, not a branch. A `Map`
 *  (not an object literal) so a lookup can never hit `Object.prototype`. */
const OPENS_QUOTE: ReadonlyMap<string, QuoteState> = new Map([
  ["'", "single"],
  ['"', "double"],
])

/** Outside quotes: whitespace separates, a quote opens a group (and STARTS a
 *  token, so `''` yields an empty token), backslash escapes, else literal. */
const stepUnquoted = (s: Scan, ch: string, next: string | undefined): number => {
  if (isArgvSpace(ch)) {
    flushToken(s)
    return 0
  }
  const opened = OPENS_QUOTE.get(ch)
  if (opened !== undefined) {
    s.state = opened
    s.hasToken = true
    return 0
  }
  if (ch === "\\") return stepEscape(s, next)
  emit(s, ch)
  return 0
}

/** State → step function. The dispatch table IS the state machine; the scan
 *  loop below is then a pure cursor. */
const SCAN_STEP: Readonly<
  Record<QuoteState, (s: Scan, ch: string, next: string | undefined) => number>
> = {
  single: (s, ch) => stepSingle(s, ch),
  double: stepDouble,
  none: stepUnquoted,
}

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

  const s: Scan = { tokens: [], current: "", hasToken: false, state: "none" }
  for (let i = 0; i < command.length; i++) {
    // Read the step BEFORE the state can change: the char is handled by the
    // state we were in on entry, exactly as the original's top-of-loop checks.
    const step = SCAN_STEP[s.state]
    i += step(s, command[i] ?? "", command[i + 1])
  }
  // Unterminated quote / final token: flush whatever we accumulated.
  flushToken(s)
  return s.tokens
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
  const inner = unwrapArrayBrackets(body)
  if (inner === null) return null

  const tokens: string[] = []
  let i = 0
  while (i < inner.length) {
    i = skipSpaces(inner, i)
    if (i >= inner.length) break
    const tok = readArrayToken(inner, i)
    if (tok === null) return null // unterminated quote / empty token
    tokens.push(tok.value)
    const afterSep = readSeparator(inner, tok.next)
    if (afterSep === null) return null // malformed separator / trailing comma
    i = afterSep
  }
  return tokens.length > 0 ? tokens : null
}

/** Strip the `[` … `]` shell. Its own unit because these are the SHAPE
 *  rejections (not bracket-delimited, unterminated, empty array) — hoisting
 *  them out leaves the loop above as pure token scanning. `null` == reject. */
const unwrapArrayBrackets = (body: string): string | null => {
  const trimmed = body.trim()
  if (trimmed.length < 2) return null
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null
  const inner = trimmed.slice(1, -1).trim()
  return inner.length === 0 ? null : inner // empty array
}

/** Advance past a run of spaces. The original spelled this inner `while`
 *  TWICE inside the outer loop, paying a nesting surcharge each time. */
const skipSpaces = (s: string, from: number): number => {
  let i = from
  while (i < s.length && isSpace(s[i] ?? "")) i++
  return i
}

/** Read ONE token at `start` — quoted or bare — plus the index just past it.
 *  `null` == reject. The two rejection reasons (unterminated quote, empty
 *  token) collapse into one unit because the caller treats them identically:
 *  a malformed array is never quietly downgraded. */
const readArrayToken = (s: string, start: number): { value: string; next: number } | null => {
  const ch = s[start] ?? ""
  const parsed = ch === '"' || ch === "'" ? readQuoted(s, start, ch) : readBare(s, start)
  if (parsed === null) return null
  return parsed.value.length === 0 ? null : parsed
}

/** After a token: consume trailing spaces, then require a comma or
 *  end-of-input. Returns the next scan index, or `null` when the separator is
 *  malformed or the comma is trailing (`[a,]`). Its own unit because it is the
 *  only place `,` means anything. */
const readSeparator = (s: string, from: number): number | null => {
  const i = skipSpaces(s, from)
  if (i >= s.length) return i
  if (s[i] !== ",") return null // malformed separator
  const next = i + 1 // consume comma
  // A trailing comma (`[a,]`) leaves only whitespace ⇒ rejected here.
  return s.slice(next).trim().length === 0 ? null : next
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
