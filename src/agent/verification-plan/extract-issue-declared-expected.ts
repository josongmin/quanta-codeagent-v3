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

export type IssueDeclaredKind = "latex" | "symbolic" | "stdout" | "stdout-empty"

export interface IssueDeclaredExpected {
  kind: IssueDeclaredKind
  value: string
}

/** Verbs that, with an explicit modal, mark a declared expected output. */
const EXPECT_RE =
  /\b(?:should|must|expected to|ought to)\s+(?:print|output|return|give|produce|render|show|be|display|yield)\b/i

/** "should <verb> `LITERAL`" — the literal must DIRECTLY follow the verb (only
 *  whitespace / `:` / `=` between). This deliberately EXCLUDES preposition-object
 *  literals like "should be returned by `solveset`" (here `solveset` is a
 *  referenced symbol, NOT the expected value) — the false positive that real
 *  issue text (sympy-18211) produced with a looser gap. Backticks or quotes. */
const EXPECT_LITERAL_RE =
  /\b(?:should|must|expected to|ought to)\s+(?:print|output|returns?|gives?|produces?|renders?|shows?|be|equals?|displays?|yields?)\s*[:=]?\s*[`'"]([^`'"\n]{1,200})[`'"]/i

/** Explicit "Expected[ output]: `LITERAL`" / "Expected[ output]: LITERAL" label. */
const EXPECTED_LABEL_RE = /\bexpected(?:\s+(?:output|result|value))?\s*[::]\s*[`'"]?([^`'"\n]{1,200}?)[`'"]?\s*(?:\n|$)/i

/** Explicit empty-output declaration. Two shapes:
 *  (1) "should <verb> nothing / no <X> / empty"  (direct empty object)
 *  (2) "should stop <subj> from <verbing>"       (e.g. pylint-4970:
 *      "should stop pylint from checking duplicate code" = emit nothing). */
const EMPTY_DECL_RE =
  /\b(?:should|must|expected to|ought to)\s+(?:(?:print|output|report|return|emit|produce|give|show)\s+(?:nothing|no\s+(?:output|duplicates?|results?|errors?|warnings?|messages?)|empty|an?\s+empty)|stop\s+\w+\s+from\s+(?:checking|reporting|flagging|emitting|printing|warning|raising))\b/i

/** LaTeX markers in a captured value. */
const LATEX_RE = /(?:\\(?:left|right|frac|begin|mathrm|operatorname|cdot|times|sqrt|sum|int)\b|\\[a-zA-Z]+\{|[\^_]\{)/

/** Python-repr-ish: a tuple/list/dict/set literal, or a call/Symbol repr. The
 *  delimiters must BOUND the value (after trim) for this to be "symbolic". */
const SYMBOLIC_RE = /^[([{].*[)\]}]$|^[A-Za-z_][\w.]*\(.*\)$/

const isMeaningful = (v: string): boolean => {
  const t = v.trim()
  if (t.length === 0) return false
  // Reject a bare single common word (e.g. "true", "this") — too weak to be an
  // exact spec. A value with structure (punctuation/space/digit) is admissible.
  if (/^[A-Za-z]+$/.test(t) && t.length < 4) return false
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
  if (problemStatement === undefined || problemStatement.trim() === "") return undefined

  // 1) Explicit empty-output declaration ⇒ stdout-empty. Checked FIRST: an
  //    "empty" decl can co-exist with a nearby literal, and the empty contract is
  //    the stronger, less-ambiguous signal.
  if (EMPTY_DECL_RE.test(problemStatement)) {
    return { kind: "stdout-empty", value: "issue declares the correct output is empty" }
  }

  // 2) "should <verb> `LITERAL`" — only when an expect verb is actually present
  //    (EXPECT_LITERAL_RE already requires it; the EXPECT_RE pre-check keeps the
  //    intent explicit and the failure mode obvious).
  if (EXPECT_RE.test(problemStatement)) {
    const m = EXPECT_LITERAL_RE.exec(problemStatement)
    if (m?.[1] !== undefined && isMeaningful(m[1])) {
      const value = m[1].trim()
      return { kind: classify(value), value }
    }
  }

  // 3) "Expected[ output]: LITERAL" label.
  const labelled = EXPECTED_LABEL_RE.exec(problemStatement)
  if (labelled?.[1] !== undefined && isMeaningful(labelled[1])) {
    const value = labelled[1].trim()
    return { kind: classify(value), value }
  }

  return undefined
}
