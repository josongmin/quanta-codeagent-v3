/**
 * Repro-test selection — pure majority-vote over the normalised source
 * forms of the candidates that reproduced the bug.
 *
 * Paper §3.3.1 algorithm (this file)
 * ==================================
 *   1. Filter: keep only samples with outcome `"reproduced"`.
 *   2. Normalise each source so superficially-different scripts that do the
 *      same thing collapse to the same key (variable test-name suffixes,
 *      whitespace, comments).
 *   3. Group by normalised key; the largest group wins; ties resolved by
 *      first appearance (the paper doesn't specify a tiebreak; first-wins
 *      is the most reproducible choice — deterministic given input order).
 *   4. Return the ORIGINAL (un-normalised) source of the chosen group's
 *      first member — the agent must see executable Python, not normalised.
 *
 * Normalisation rules (pure, in order)
 * ====================================
 *   a. Strip line comments (`#` to end-of-line, ignoring `#` inside strings).
 *   b. Strip triple-quoted docstrings (both `'''` and `"""` flavours).
 *   c. Replace function names `test_<any>` with `test_repro` so the LLM's
 *      arbitrary `def test_xxx_42():` doesn't fork the group key.
 *   d. Collapse runs of whitespace within a line to one space; strip
 *      trailing whitespace on each line.
 *   e. Collapse runs of blank lines to a single blank line.
 *   f. Strip leading + trailing whitespace from the final string.
 *
 * Posture
 * =======
 *   - Pure. No I/O. Deterministic on input.
 *   - The string-aware comment stripper is INTENTIONALLY conservative:
 *     it tracks whether we're inside a `'` / `"` / `'''` / `"""` literal so
 *     a `#` inside a string literal isn't mistaken for a comment. It does
 *     NOT parse Python — the goal is "normalise enough that the obvious
 *     paraphrase doesn't fool the majority vote", not "be a Python AST".
 *     A pathological input (raw string with embedded triple-quote, …) MAY
 *     normalise imperfectly — the majority vote degrades gracefully (more
 *     unique groups → smaller-than-ideal winner). It never CRASHES.
 */

import type { ReproTestSample, ReproTestSelection } from "./types"

/**
 * G2 paired-control selection options.
 *
 *   - `pairedControl` — when `true`, the admission predicate is TIGHTENED from
 *     `outcome === "reproduced"` to `outcome === "reproduced" && baseControl ===
 *     "green"`. A sample whose paired control tests did NOT all pass on the base
 *     tree (`"red"` env/import-broken, or `"absent"` un-certified) is REJECTED
 *     as a candidate false-red and excluded from the majority vote.
 *
 * Default (`undefined`/`false`) ⇒ byte-identical legacy filter.
 */
export interface SelectReproTestOptions {
  readonly pairedControl?: boolean
}

const TEST_FN_RE = /\bdef\s+test_[A-Za-z0-9_]+/g
const TRAILING_WS_RE = /[ \t]+$/

/** Strip `#`-to-EOL comments, RESPECTING string literals.
 *
 *  State machine:
 *    - 0: code (not inside any literal)
 *    - 1: inside `'`-delimited string
 *    - 2: inside `"`-delimited string
 *    - 3: inside `'''`-delimited string
 *    - 4: inside `"""`-delimited string
 *
 *  Inside states 1/2/3/4 a `#` is data, not a comment. Inside states 1/2
 *  a NEWLINE without a backslash closes the literal (Python rule).
 *  Backslash-quote inside states 1/2 escapes the quote.
 *
 *  Exported for direct unit testing — the worst foot-gun in this slice. */
type StripState = 0 | 1 | 2 | 3 | 4

interface StripStep {
  appended: string
  delta: number
  state: StripState
}

/** Code-mode (state 0) step: decide what to do with the current char. */
const stepCode = (src: string, i: number, n: number): StripStep => {
  const c = src[i] as string
  if (c === '"' && src.slice(i, i + 3) === '"""') return { appended: '"""', delta: 3, state: 4 }
  if (c === "'" && src.slice(i, i + 3) === "'''") return { appended: "'''", delta: 3, state: 3 }
  if (c === '"') return { appended: c, delta: 1, state: 2 }
  if (c === "'") return { appended: c, delta: 1, state: 1 }
  if (c === "#") {
    // Eat to end-of-line. Return the number of chars consumed, no output.
    let j = i
    while (j < n && src[j] !== "\n") j++
    return { appended: "", delta: j - i, state: 0 }
  }
  return { appended: c, delta: 1, state: 0 }
}

/** Single-quote string step. Backslash escapes; newline closes. `quote` is
 *  the literal delimiter that closes the string. */
const stepSingleQuoted = (src: string, i: number, n: number, quote: "'" | '"'): StripStep => {
  const c = src[i] as string
  if (c === "\\" && i + 1 < n)
    return { appended: c + (src[i + 1] ?? ""), delta: 2, state: quote === "'" ? 1 : 2 }
  if (c === quote) return { appended: c, delta: 1, state: 0 }
  if (c === "\n") return { appended: c, delta: 1, state: 0 }
  return { appended: c, delta: 1, state: quote === "'" ? 1 : 2 }
}

/** Triple-quoted string step. Only the matching triple-quote closes. */
const stepTripleQuoted = (src: string, i: number, triple: "'''" | '"""'): StripStep => {
  const c = src[i] as string
  if (src.slice(i, i + 3) === triple) return { appended: triple, delta: 3, state: 0 }
  return { appended: c, delta: 1, state: triple === "'''" ? 3 : 4 }
}

/** Pure dispatch from `(state, src, i, n)` to the next `StripStep`. Keeps
 *  `stripPythonComments` itself a tiny loop body (complexity under the
 *  biome ceiling). */
const dispatchStep = (state: StripState, src: string, i: number, n: number): StripStep => {
  const handlers: Record<StripState, () => StripStep> = {
    0: () => stepCode(src, i, n),
    1: () => stepSingleQuoted(src, i, n, "'"),
    2: () => stepSingleQuoted(src, i, n, '"'),
    3: () => stepTripleQuoted(src, i, "'''"),
    4: () => stepTripleQuoted(src, i, '"""'),
  }
  return handlers[state]()
}

export const stripPythonComments = (src: string): string => {
  let state: StripState = 0
  let out = ""
  let i = 0
  const n = src.length
  while (i < n) {
    if (src[i] === undefined) {
      i++
      continue
    }
    const step = dispatchStep(state, src, i, n)
    out += step.appended
    i += step.delta
    state = step.state
  }
  return out
}

/** Strip triple-quoted docstring blocks. Conservative: we drop *every*
 *  `'''…'''` and `"""…"""` block at the top level of a function/class body
 *  (the LLM's idea of a docstring) and also any other balanced triple-quote
 *  block that appears outside an assignment context. Implementation simply
 *  removes triple-quote blocks IN BULK — Python's own grammar allows them
 *  as expression-statements anywhere, and our normaliser doesn't need to
 *  preserve them for execution (the source returned by `selectReproTest` is
 *  the ORIGINAL, not the normalised form). */
const stripDocstrings = (src: string): string => {
  // Drop every `"""…"""` and `'''…'''` block, including the delimiters.
  // We use a non-greedy match across lines (`[\s\S]*?`) so each closing
  // triple-quote terminates the match at the earliest opportunity.
  return src.replace(/"""[\s\S]*?"""/g, "").replace(/'''[\s\S]*?'''/g, "")
}

/** Normalise function names so `def test_unicode_error_42()` and
 *  `def test_repro()` collapse to the same key. Class/method names that
 *  *happen* to start with `test_` are also normalised — the LLM rarely
 *  emits classes here and the false-positive cost is bounded (the group key
 *  is more permissive, but the ORIGINAL source is what the caller gets). */
const normaliseTestFnNames = (src: string): string => src.replace(TEST_FN_RE, "def test_repro")

/** Collapse whitespace runs within each non-blank line; trim trailing
 *  whitespace; collapse multiple blank lines to one. */
const collapseWhitespace = (src: string): string => {
  const lines = src.split(/\r?\n/)
  const out: string[] = []
  let prevBlank = false
  for (const ln of lines) {
    // Trim trailing whitespace and collapse internal runs.
    const trimmed = ln.replace(TRAILING_WS_RE, "")
    const collapsed = trimmed.replace(/[ \t]{2,}/g, " ")
    const isBlank = collapsed.trim() === ""
    if (isBlank) {
      if (!prevBlank) out.push("")
      prevBlank = true
    } else {
      out.push(collapsed)
      prevBlank = false
    }
  }
  return out.join("\n").trim()
}

/**
 * Normalise a candidate's source for group keying. Exported for direct
 * unit testing — the rules are subtle.
 *
 * Order matters:
 *   1. docstring removal FIRST so the comment-aware stripper doesn't have
 *      to track triple-quotes.
 *   2. comment removal.
 *   3. function-name normalisation.
 *   4. whitespace normalisation last (so prior steps' newline-preserving
 *      output collapses correctly).
 */
export const normaliseReproSource = (src: string): string => {
  if (typeof src !== "string" || src.length === 0) return ""
  const a = stripDocstrings(src)
  const b = stripPythonComments(a)
  const c = normaliseTestFnNames(b)
  return collapseWhitespace(c)
}

/**
 * Majority-vote selector. Pure. Returns `null` when no sample reproduced
 * the bug — the caller decides whether to fall back to a no-hint posture.
 *
 * Ties: first-appearance wins. The paper does not specify a tie-break; we
 * choose "first" because it is deterministic given input order and is the
 * shape every observability tool can reproduce.
 */
interface Bucket {
  key: string
  count: number
  firstSource: string
  order: number
}

/** Bucket reproduced samples by normalised-key; preserve first-appearance
 *  `order` on each bucket so the winner-pick is deterministic. */
const bucketReproduced = (reproduced: readonly ReproTestSample[]): Map<string, Bucket> => {
  const buckets = new Map<string, Bucket>()
  for (let i = 0; i < reproduced.length; i++) {
    const sample = reproduced[i]
    if (sample === undefined) continue
    const key = normaliseReproSource(sample.source)
    const existing = buckets.get(key)
    if (existing === undefined) {
      buckets.set(key, { key, count: 1, firstSource: sample.source, order: i })
    } else {
      existing.count += 1
    }
  }
  return buckets
}

/** Pick the bucket with the highest count; tiebreak = lowest `order`. */
const pickWinner = (buckets: Iterable<Bucket>): Bucket | undefined => {
  let winner: Bucket | undefined
  for (const b of buckets) {
    if (winner === undefined || b.count > winner.count) {
      winner = b
    } else if (b.count === winner.count && b.order < winner.order) {
      winner = b
    }
  }
  return winner
}

/** G2 admission predicate. The base filter is `outcome === "reproduced"`. When
 *  `pairedControl` is on, a reproducing sample is ADMITTED only if its paired
 *  control verdict is `"green"` (controls passed on base ⇒ env healthy ⇒ the
 *  base-red symptom is a REAL reproduction, not a false-red from a broken env).
 *  This is the single reader site that branches behavior on `baseControl`. */
const admits = (sample: ReproTestSample, pairedControl: boolean): boolean => {
  if (sample.outcome !== "reproduced") return false
  if (!pairedControl) return true
  // Fail-closed: only a certified-green control admits. `"red"` (env broken)
  // and `"absent"` (no control run) are both rejected.
  return sample.baseControl === "green"
}

export const selectReproTest = (
  samples: readonly ReproTestSample[],
  opts: SelectReproTestOptions = {},
): ReproTestSelection => {
  const pairedControl = opts.pairedControl === true
  const reproduced = samples.filter((s) => admits(s, pairedControl))
  const reproducedCount = reproduced.length
  // Count reproducers that the paired-control gate threw out (only meaningful
  // when the gate is on; 0 otherwise).
  const controlRejectedCount = pairedControl
    ? samples.filter((s) => s.outcome === "reproduced" && s.baseControl !== "green").length
    : 0
  if (reproducedCount === 0) {
    return { selected: null, samples, reproducedCount: 0, controlRejectedCount }
  }
  const buckets = bucketReproduced(reproduced)
  const winner = pickWinner(buckets.values())
  return {
    selected: winner !== undefined ? winner.firstSource : null,
    samples,
    reproducedCount,
    controlRejectedCount,
  }
}
