/**
 * RFC-07 G1 (aug-22 흡수) — exact `gh pr <verb>` argv → PR action grammar.
 *
 * PURE, no I/O. Consumes the raw command string, isolates the ONE unambiguous
 * `gh pr <verb>` simple-command, tokenizes it with quote/comment awareness, and
 * maps the verb (plus the small flag set that splits a verb into distinct
 * actions) onto a CLOSED {@link VcsPrAction} union.
 *
 * Discipline (matches the classifier's command-shape gate, never a stdout
 * scrape):
 *  - the command WORD of a segment must be `gh` (env-prefix / absolute path
 *    tolerated); a `gh pr create` inside an `echo`/quoted arg cannot classify.
 *  - a malformed segment (unterminated quote ⇒ a shell-operator split broke a
 *    heredoc/multiline string) ⇒ omit (return `null`); never guess.
 *  - zero OR more-than-one gh-pr segment ⇒ ambiguous ⇒ omit.
 *  - read-only verbs (view/list/status/checks/diff/…), unknown verbs, aliases
 *    not spelled `pr`, and conflicting flags ⇒ no action.
 *
 * The action union and this table are ONE owner. Consumers store the value
 * verbatim; they never remap a verb.
 */

/** Closed PR-action union (R5 grammar table). Adding a value is a compile error
 *  at every exhaustive consumer. */
export type VcsPrAction =
  | "created"
  | "edited"
  | "merged"
  | "commented"
  | "closed"
  | "reopened"
  | "ready"
  | "draft"
  | "auto-merge-enabled"
  | "auto-merge-disabled"

/** Result of parsing the (single, unambiguous) `gh pr <verb>` segment.
 *  `action` is omitted for read-only/unknown/conflicting verbs; `number` is the
 *  explicit PR selector when it appears as a bare digit token immediately after
 *  the verb (gh's `<number>` positional). */
export interface GhPrCommand {
  readonly action?: VcsPrAction
  readonly number?: number
}

/** Split on top-level shell sequencing operators — same shape as the classifier
 *  uses so behavior is consistent. NOT quote-aware (a quoted operator will
 *  over-split, surfacing as an unterminated-quote segment which we omit-safely). */
const splitSimpleCommands = (command: string): string[] =>
  command.split(/\s*(?:&&|\|\||[;&|\n])\s*/).filter((s) => s.length > 0)

/** A segment whose command word is `gh` (tolerating env-var prefixes and an
 *  absolute/relative path). Cheap pre-filter so we only tokenize gh segments. */
const GH_START = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?gh(?:\s|$)/
/** An env-var assignment prefix token (`FOO=bar`). */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
/** The command-word token is the `gh` binary (bare, path, but NOT an env pair). */
const GH_WORD = /(?:^|\/)gh$/
/** A bare positive-integer PR selector. */
const PR_NUMBER = /^\d+$/

const isQuoteChar = (ch: string): ch is '"' | "'" => ch === '"' || ch === "'"
const isSpace = (ch: string): boolean => ch === " " || ch === "\t"

/**
 * Tokenize ONE simple-command with quote + comment awareness. Single/double
 * quotes protect whitespace (so a `--body "gh pr close"` value is one token and
 * cannot hijack the verb). A `#` at a token boundary starts a shell comment. An
 * unterminated quote ⇒ `null` (the segment is malformed — a shell-operator split
 * broke a heredoc/multiline string — and must not be parsed).
 */
const tokenizeSegment = (seg: string): string[] | null => {
  const tokens: string[] = []
  let cur = ""
  let has = false
  let quote: '"' | "'" | null = null
  const flush = (): void => {
    if (has) {
      tokens.push(cur)
      cur = ""
      has = false
    }
  }
  for (const ch of seg) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else {
        cur += ch
        has = true
      }
    } else if (isQuoteChar(ch)) {
      quote = ch
      has = true
    } else if (ch === "#" && !has) {
      break // comment at a token boundary ⇒ ignore the rest
    } else if (isSpace(ch)) {
      flush()
    } else {
      cur += ch
      has = true
    }
  }
  if (quote !== null) return null // unterminated quote ⇒ malformed segment
  flush()
  return tokens
}

/** Map an already-isolated `verb` + its flag tokens to a closed action (or
 *  `undefined` for read-only/unknown/conflicting). The ONLY flags that change a
 *  verb's action are merge's `--auto`/`--disable-auto` and ready's `--undo`. */
const mapVerb = (verb: string, flags: readonly string[]): VcsPrAction | undefined => {
  switch (verb) {
    case "create":
      return "created"
    case "edit":
      return "edited"
    case "comment":
      return "commented"
    case "close":
      return "closed"
    case "reopen":
      return "reopened"
    case "merge": {
      const auto = flags.includes("--auto")
      const disable = flags.includes("--disable-auto")
      if (auto && disable) return undefined // conflicting flags ⇒ omit (never guess)
      if (auto) return "auto-merge-enabled"
      if (disable) return "auto-merge-disabled"
      return "merged"
    }
    case "ready":
      return flags.includes("--undo") ? "draft" : "ready"
    default:
      // read-only verbs (view/list/status/checks/diff), unknown verbs, aliases.
      return undefined
  }
}

/** Parse ONE unambiguous `gh pr <verb> …` segment out of `command`. */
const parseSegment = (tokens: readonly string[]): GhPrCommand | undefined => {
  // Skip env-assignment prefixes to reach the command word.
  let i = 0
  while (i < tokens.length && ENV_ASSIGN.test(tokens[i] ?? "")) i++
  const cmdWord = tokens[i]
  if (cmdWord === undefined || !GH_WORD.test(cmdWord)) return undefined
  if (tokens[i + 1] !== "pr") return undefined
  const verb = tokens[i + 2]
  if (verb === undefined) return undefined // `gh pr` with no verb

  const rest = tokens.slice(i + 3)
  const action = mapVerb(verb, rest)

  // Explicit PR selector = a bare digit token IMMEDIATELY after the verb (gh's
  // `<number>` positional). Restricting to the adjacent position avoids mistaking
  // a value-taking flag's argument (`--title 3`) for the PR number.
  const first = rest[0]
  const number =
    first !== undefined && PR_NUMBER.test(first) ? Number.parseInt(first, 10) : undefined

  const out: { action?: VcsPrAction; number?: number } = {}
  if (action !== undefined) out.action = action
  if (number !== undefined && Number.isInteger(number)) out.number = number
  return out
}

/**
 * Isolate and parse the single unambiguous `gh pr <verb>` command in `command`.
 * Returns `null` when there is no gh-pr segment, when more than one exists
 * (ambiguous), or when a gh segment is malformed (broken quote/heredoc).
 */
export const parseGhPrCommand = (command: string): GhPrCommand | null => {
  const candidates: GhPrCommand[] = []
  for (const raw of splitSimpleCommands(command)) {
    const seg = raw.trimStart()
    if (!GH_START.test(seg)) continue
    const tokens = tokenizeSegment(seg)
    if (tokens === null) return null // malformed gh segment ⇒ omit (never guess)
    const parsed = parseSegment(tokens)
    if (parsed !== undefined) candidates.push(parsed)
  }
  if (candidates.length !== 1) return null // zero or ambiguous(>1) ⇒ omit
  return candidates[0] ?? null
}
