/**
 * Extract a PUBLIC issue-declared expected output from a problem statement.
 *
 * gap-B spec-fidelity rail (jun-17 proof-driven bench closure). Feeds
 * {@link VerificationPlanInput.issueDeclaredExpected} so a typed exact-output
 * contract can be attached to the primary rail (observe-only artifact) and so the
 * spec-fidelity steer can FIRE ONLY when a concrete expected output is present.
 *
 * Design — **FAIL-CLOSED, precision over recall**:
 *  - Return a value ONLY when the issue text carries an EXPLICIT marker
 *    ("should print/return/be `X`", "expected: `X`", "should report nothing")
 *    binding a delimited literal (or an explicit empty-output declaration).
 *  - Anything ambiguous ⇒ `undefined`. A blanket minimality nudge would WORSEN
 *    co-change cases (sympy-15976 / sympy-21930), so the gate must stay narrow.
 *  - The extracted VALUE is NEVER injected into the model prompt. It only
 *    (a) gates the generic steer and (b) populates the observe-only predicate.
 *    So a mis-classified value cannot anchor the model on a wrong spec — the
 *    model reads the issue itself, not this output.
 *
 * Pure + deterministic: no I/O, no LLM, no clock/random.
 */

import { normalizePublicIssueText } from "@/shared"

export type IssueDeclaredKind = "latex" | "symbolic" | "stdout" | "stdout-empty"

/** Provenance of a declared-expected invariant. Stamped ONLY by
 *  {@link extractIssueDeclaredExpected}, which reads PUBLIC problem-statement
 *  text exclusively (never test_patch / gold / PR diff / grading output). The
 *  T2b clean-mode spec-fidelity veto fires only for this source — the answer-key
 *  guard in the declared-expected matcher refuses anything else. */
export const PUBLIC_ISSUE_TEXT_PROVENANCE = "public-issue-text" as const

export interface IssueDeclaredExpected {
  kind: IssueDeclaredKind
  value: string
  readonly provenance: typeof PUBLIC_ISSUE_TEXT_PROVENANCE
}

const declared = (kind: IssueDeclaredKind, value: string): IssueDeclaredExpected => ({
  kind,
  value,
  provenance: PUBLIC_ISSUE_TEXT_PROVENANCE,
})

/** "should <verb> `LITERAL`" — the literal must DIRECTLY follow the verb (only
 *  whitespace / `:` / `=` between). This deliberately EXCLUDES preposition-object
 *  literals like "should be returned by `solveset`" (here `solveset` is a
 *  referenced symbol, NOT the expected value) — the false positive that real
 *  issue text (sympy-18211) produced with a looser gap. Backticks or quotes. */
const EXPECT_LITERAL_RE =
  /\b(?:should|must|expected to|ought to)\s+(?:print|output|returns?|gives?|produces?|renders?|shows?|be|equals?|displays?|yields?)\s*[:=]?\s*[`'"]([^`'"\n]{1,200})[`'"]/i

/** Explicit "Expected[ output]: `LITERAL`" label — the value MUST be delimited
 *  (backtick/quote). The earlier optional-quote branch captured UNQUOTED prose
 *  ("Expected: the function works correctly") as a spec — a false positive that
 *  fires the steer on issues with no concrete declared output. Requiring
 *  delimiters mirrors EXPECT_LITERAL_RE's precision and costs no recall (real
 *  declared-output issues quote the value). */
const EXPECTED_LABEL_RE =
  /\bexpected(?:\s+(?:output|result|value))?\s*[::]\s*[`'"]([^`'"\n]{1,200})[`'"]/i

/** Desired output declared inside a FENCED CODE BLOCK after an explicit
 *  desired-output marker ("should be:", "better to be ... to:", "expected
 *  output:"). Captures the block body (≤400 chars) after the marker+`:`+fence;
 *  the body is then scanned for a QUOTED literal ({@link QUOTED_IN_BODY}). This
 *  is the common repr/LaTeX issue shape (sympy-18763) the inline patterns miss.
 *  The marker is REQUIRED so an example/input block (no desired-output marker)
 *  never matches — fail-closed. */
const CODEBLOCK_MARKER_RE =
  /\b(?:should be|better to be|would be better|ought to be|expected output|correct output)\b[^\n]{0,80}?:\s*```[a-zA-Z]*\s*([\s\S]{0,400}?)```/i

/** Exact error-message proposals often appear as:
 *  "Proposal: change the message to the form of:\n```ValueError: ...```".
 *  Here the whole block is the expected message; extracting the first quoted
 *  literal inside it would collapse the spec to a single token like `time`. */
const MESSAGE_FORM_CODEBLOCK_RE =
  /\b(?:change|changed|changing)\s+(?:the\s+)?(?:error\s+|exception\s+)?message\b[^\n]{0,120}\b(?:to|as|form of)\b[^\n]{0,80}:\s*```[a-zA-Z]*\s*([\s\S]{0,400}?)```/i

/** First delimited literal inside a captured code-block body. A block with NO
 *  quoted literal yields nothing (avoids grabbing bare example CODE as output). */
const QUOTED_IN_BODY = /[`'"]([^`'"\n]{1,200})[`'"]/

/** Explicit empty-output declaration. Two shapes:
 *  (1) "should <verb> nothing / no <X> / empty"  (direct empty object)
 *  (2) "should stop <subj> from <verbing>"       (e.g. pylint-4970:
 *      "should stop pylint from checking duplicate code" = emit nothing). */
const EMPTY_DECL_RE =
  /\b(?:should|must|expected to|ought to)\s+(?:(?:print|output|report|return|emit|produce|give|show)\s+(?:nothing|no\s+(?:output|duplicates?|results?|errors?|warnings?|messages?)|empty|an?\s+empty)|stop\s+\w+\s+from\s+(?:checking|reporting|flagging|emitting|printing|warning|raising))\b/i

/** LaTeX markers in a captured value. */
const LATEX_RE =
  /(?:\\(?:left|right|frac|begin|mathrm|operatorname|cdot|times|sqrt|sum|int)\b|\\[a-zA-Z]+\{|[\^_]\{)/

/** Python-repr-ish: a tuple/list/dict/set literal, or a call/Symbol repr. The
 *  delimiters must BOUND the value (after trim) for this to be "symbolic". */
const SYMBOLIC_RE = /^[([{].*[)\]}]$|^[A-Za-z_][\w.]*\(.*\)$/

/** A "bare word" = letters only, no punctuation / whitespace / digit. Such a
 *  value classifies as `stdout` (neither LATEX nor SYMBOLIC matches) and so
 *  build.ts turns it into a `{ type: "stdout_contains", substring }` contract —
 *  satisfied if the patched tree prints the word ANYWHERE. Common broad tokens
 *  (`none`/`null`/`pass`/`true`/`error`/`false`, ≤5 chars) are therefore a
 *  false-green spec rail. We require STRUCTURE (punctuation / whitespace / a
 *  digit) OR a higher length bound (>6 chars) before admitting a bare word —
 *  a STRUCTURAL rule, not a denylist, so any short broad token is rejected while
 *  genuinely-specific structured / multi-token outputs still pass. */
const BARE_WORD_MIN_LEN = 7
const isMeaningful = (v: string): boolean => {
  const t = v.trim()
  if (t.length === 0) return false
  // A bare alpha-only single word with no structure is admissible only when it
  // is long enough to be a specific substring; short common words are rejected.
  if (/^[A-Za-z]+$/.test(t) && t.length < BARE_WORD_MIN_LEN) return false
  return true
}

const classify = (value: string): IssueDeclaredKind => {
  const t = value.trim()
  if (LATEX_RE.test(t)) return "latex"
  if (SYMBOLIC_RE.test(t)) return "symbolic"
  return "stdout"
}

/**
 * Returns the declared expected output, or `undefined` when none is confidently
 * present. Precision-first: the FIRST high-confidence match wins; absent an
 * explicit marker the result is `undefined` (never a guess).
 */
export const extractIssueDeclaredExpected = (
  problemStatement: string | undefined,
): IssueDeclaredExpected | undefined => {
  const normalized = normalizePublicIssueText(problemStatement)
  if (normalized === undefined || normalized.trim() === "") return undefined

  // 1) Explicit empty-output declaration ⇒ stdout-empty. Checked FIRST: an
  //    "empty" decl can co-exist with a nearby literal, and the empty contract is
  //    the stronger, less-ambiguous signal.
  if (EMPTY_DECL_RE.test(normalized)) {
    return declared("stdout-empty", "issue declares the correct output is empty")
  }

  // 2) "should <verb> `LITERAL`" — EXPECT_LITERAL_RE self-contains the required
  //    modal + expect-verb + delimited-literal, so it is the sole gate here. (A
  //    prior narrower EXPECT_RE pre-check was removed: its verb list lacked
  //    `equals?` and the plural forms `returns?`/`gives?`/… present in
  //    EXPECT_LITERAL_RE, so it could ONLY subtract valid matches — adding zero
  //    precision while silently dropping real declared outputs like
  //    "should equal `(1,)`".)
  const m = EXPECT_LITERAL_RE.exec(normalized)
  if (m?.[1] !== undefined && isMeaningful(m[1])) {
    const value = m[1].trim()
    return declared(classify(value), value)
  }

  // 3) "Expected[ output]: LITERAL" label.
  const labelled = EXPECTED_LABEL_RE.exec(normalized)
  if (labelled?.[1] !== undefined && isMeaningful(labelled[1])) {
    const value = labelled[1].trim()
    return declared(classify(value), value)
  }

  // 4) Exact error-message proposal in a fenced block. The FULL block is the
  //    expected stdout/message text, not a quoted sub-literal inside it.
  const msgBlock = MESSAGE_FORM_CODEBLOCK_RE.exec(normalized)
  if (msgBlock?.[1] !== undefined && isMeaningful(msgBlock[1])) {
    const value = msgBlock[1].trim()
    return declared(classify(value), value)
  }

  // 5) Desired output in a FENCED CODE BLOCK after a desired-output marker
  //    ("should be:", "better to be ... to:", "expected output:"). The marker
  //    anchors the block AFTER it, so an earlier "gives:"/example block (the
  //    INCORRECT current output) is skipped. Fail-closed twice: the marker is
  //    required, AND a QUOTED literal must exist in the block (bare example code
  //    yields nothing). Recall lift for sympy-18763-class repr/LaTeX issues.
  const cb = CODEBLOCK_MARKER_RE.exec(normalized)
  if (cb?.[1] !== undefined) {
    const q = QUOTED_IN_BODY.exec(cb[1])
    if (q?.[1] !== undefined && isMeaningful(q[1])) {
      const value = q[1].trim()
      return declared(classify(value), value)
    }
  }

  return undefined
}
