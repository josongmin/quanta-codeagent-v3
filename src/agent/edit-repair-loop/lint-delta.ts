/**
 * Lint-delta computer (ADR-0472) — pure fn, NO ports, NO I/O.
 *
 * Given the diagnostics BEFORE an edit (`preDiags`) and AFTER (`postDiags`),
 * returns ONLY the diagnostics the edit INTRODUCED — i.e. present in `post` but
 * not in `pre`. This is the load-bearing primitive: it is what lets us attach
 * "your edit added these lints" to the edit tool's `toModelOutput` WITHOUT
 * blaming the model for the file's pre-existing lint debt.
 *
 * Identity is the `(file, line, code, message)` tuple (see {@link diagnosticKey})
 * — NOT column/severity — so a pre-existing lint that merely shifts column after
 * the edit is NOT reported as introduced. Multiplicity is honoured via a count
 * multiset: if `pre` had ONE "no-unused-vars" at L10 and `post` has TWO, exactly
 * ONE is reported as introduced (the net-new occurrence), not both.
 *
 * Slices imported: NONE (pure). NO-THROW: total function over its inputs.
 */

import type { Diagnostic } from "./types"

/**
 * Stable identity key for delta purposes. Column and severity are deliberately
 * EXCLUDED so a benign column shift never registers as a new lint. The tuple is
 * JSON-encoded (length-prefixed strings) rather than `\x00`-joined: a message
 * that echoes source containing a NUL byte could otherwise straddle a field
 * boundary and COLLIDE two distinct diagnostics into one key — suppressing a
 * genuinely-introduced lint (a false negative). JSON encoding is collision-free
 * regardless of field content.
 */
export const diagnosticKey = (d: Diagnostic): string =>
  JSON.stringify([d.file, d.line, d.code, d.message])

/**
 * Compute the introduced diagnostics: `post` minus `pre` as a count-aware
 * multiset difference, preserving `post` ordering. Pure.
 *
 *  - A diagnostic in `post` whose key has no remaining budget in `pre` is
 *    INTRODUCED.
 *  - A diagnostic in `post` whose key still has budget in `pre` is pre-existing
 *    and consumes one unit of that budget (so duplicates are matched 1-for-1).
 */
export const computeLintDelta = (
  preDiags: readonly Diagnostic[],
  postDiags: readonly Diagnostic[],
): readonly Diagnostic[] => {
  // Multiset of pre-existing keys with remaining match budget.
  const budget = new Map<string, number>()
  for (const d of preDiags) {
    const k = diagnosticKey(d)
    budget.set(k, (budget.get(k) ?? 0) + 1)
  }

  const introduced: Diagnostic[] = []
  for (const d of postDiags) {
    const k = diagnosticKey(d)
    const remaining = budget.get(k) ?? 0
    if (remaining > 0) {
      // Matches a pre-existing diagnostic — consume budget, not introduced.
      budget.set(k, remaining - 1)
    } else {
      introduced.push(d)
    }
  }
  return introduced
}

/** Identity key WITHOUT line — `(file, code, message)`. Used by the
 *  line-shift-tolerant delta so a diagnostic that merely moved lines can still
 *  match its pre-edit twin within a tolerance window. JSON-encoded (not
 *  `\x00`-joined) for the same collision-free reason as {@link diagnosticKey}. */
const groupKey = (d: Diagnostic): string => JSON.stringify([d.file, d.code, d.message])

/**
 * Line-shift-tolerant introduced-diagnostics delta (ADR-0495).
 *
 * The plain {@link computeLintDelta} keys on the exact line, so an edit that
 * inserts/removes lines renumbers every later diagnostic and FALSELY reports the
 * shifted pre-existing lints as "introduced". This variant mirrors Claude Code:
 * a `post` diagnostic is pre-existing iff it can be MATCHED to an unconsumed
 * `pre` diagnostic that shares `(file, code, message)` AND lies within
 * `|lineShift|` lines (the edit's net line delta is the tolerance window). The
 * remaining unmatched `post` diagnostics are the introduced set, returned in
 * ORIGINAL `post` order.
 *
 * Matching is MAXIMUM-cardinality, not greedy-nearest: within a group it sorts
 * pre and post by line and assigns each post (ascending) the SMALLEST unused pre
 * still inside its window. This is the classic optimal greedy for interval point
 * matching — it never strands a pre that a later post needed (a bug greedy
 * nearest-first has: pre=[10,14] post=[13,16] tol=3 ⇒ optimal []; nearest ⇒ [16]).
 *
 * Properties: `lineShift === 0` reproduces {@link computeLintDelta} exactly
 * (line must match), so it is a strict SUPERSET — safe to adopt behind a gate.
 * Pure + NO-THROW: a non-finite / negative / fractional `lineShift` is coerced
 * to a non-negative integer tolerance (`|trunc|`, NaN ⇒ 0); never throws.
 */
interface PostItem {
  /** Original index in `postDiags` (to restore order + mark matched). */
  readonly idx: number
  readonly line: number
}

/** Mark which post items in a single group are matched to a pre line. Sorts both
 *  ascending and assigns each post the smallest unused pre within `tol` — the
 *  optimal greedy for interval matching. Mutates `matched` in place. */
const matchGroup = (
  preLinesSorted: readonly number[],
  postItems: readonly PostItem[],
  tol: number,
  matched: boolean[],
): void => {
  const used = new Array<boolean>(preLinesSorted.length).fill(false)
  const byLine = [...postItems].sort((a, b) => a.line - b.line)
  for (const p of byLine) {
    for (let j = 0; j < preLinesSorted.length; j++) {
      if (used[j]) continue
      const preLine = preLinesSorted[j] as number
      if (preLine < p.line - tol) continue
      if (preLine > p.line + tol) break // sorted ⇒ no further candidate
      used[j] = true
      matched[p.idx] = true
      break
    }
  }
}

export const computeLintDeltaTolerant = (
  preDiags: readonly Diagnostic[],
  postDiags: readonly Diagnostic[],
  lineShift: number,
): readonly Diagnostic[] => {
  const t = Math.trunc(lineShift)
  const tol = Number.isFinite(t) ? Math.abs(t) : 0
  // Group pre lines + post items by (file,code,message).
  const preByKey = new Map<string, number[]>()
  for (const d of preDiags) {
    const arr = preByKey.get(groupKey(d))
    if (arr) arr.push(d.line)
    else preByKey.set(groupKey(d), [d.line])
  }
  const postByKey = new Map<string, PostItem[]>()
  for (let i = 0; i < postDiags.length; i++) {
    const d = postDiags[i] as Diagnostic
    const item: PostItem = { idx: i, line: d.line }
    const arr = postByKey.get(groupKey(d))
    if (arr) arr.push(item)
    else postByKey.set(groupKey(d), [item])
  }
  const matched = new Array<boolean>(postDiags.length).fill(false)
  for (const [key, postItems] of postByKey) {
    const preLinesSorted = [...(preByKey.get(key) ?? [])].sort((a, b) => a - b)
    matchGroup(preLinesSorted, postItems, tol, matched)
  }
  const introduced: Diagnostic[] = []
  for (let i = 0; i < postDiags.length; i++) {
    if (!matched[i]) introduced.push(postDiags[i] as Diagnostic)
  }
  return introduced
}

/**
 * Render introduced diagnostics for the edit tool's `toModelOutput`. Empty ⇒ a
 * single positive line so the model gets explicit "no new lints" confirmation
 * (not silence, which it cannot distinguish from "not checked").
 */
export const renderLintDelta = (introduced: readonly Diagnostic[]): string => {
  if (introduced.length === 0) return "Lint delta: this edit introduced no new diagnostics."
  const head = `Lint delta: this edit introduced ${introduced.length} new diagnostic${
    introduced.length === 1 ? "" : "s"
  }:`
  const rows = introduced.map((d) => {
    const col = d.column !== undefined ? `:${d.column}` : ""
    const code = d.code.length > 0 ? ` [${d.code}]` : ""
    return `  ${d.file}:${d.line}${col} (${d.severity})${code} ${d.message}`
  })
  return [head, ...rows].join("\n")
}
