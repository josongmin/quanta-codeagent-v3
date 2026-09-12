/**
 * `tools/test-resilience/diagnose` — bounded, deduplicated, batched diagnosis.
 *
 * # The amplification this removes
 *
 * The old loop was: for EVERY parsed failure, spawn `bun test <file> -t <leaf>`;
 * if `-t` matched nothing, spawn `bun test <file>` as well. With 20 failures in
 * one file that is 20 children, or 40 when the names contain regex
 * metacharacters — and `(` / `[` / `*` are common in this repo's test names, so
 * the 40 case is the normal one, not the pathological one. On a box already at
 * load 100 (which is WHY the twenty failed), the diagnosis is a second load
 * spike that manufactures more failures to diagnose.
 *
 * Three structural changes:
 *
 *  1. **Dedupe by `(file, exact test id, fingerprint)`.** The same test failing
 *     the same way twice is one diagnosis. The same test failing two DIFFERENT
 *     ways is two — isolating one says nothing about the other, so the
 *     fingerprint is part of the key, not a nicety.
 *  2. **One child per FILE.** Every distinct test in a file goes into a single
 *     `-t` alternation of literally-escaped names. 20-in-one-file becomes 1.
 *  3. **A global budget.** Children, and wall time, across the whole diagnosis.
 *     When the budget runs out the remaining work is reported as
 *     `budget-exhausted` — which is an `inconclusive`, never a pass.
 *
 * # Why a zero-match no longer escalates
 *
 * The old comment argued that a `-t` that matched nothing should fall back to
 * running the whole file, so a real failure with an awkward name would not be
 * mislabelled. The premise was right and the fix was in the wrong place: the
 * reason `-t` matched nothing is that the pattern was not escaped. `-t` is a
 * REGEX (measured: `-t 'beta \[two\]'` selects, `-t 'beta [two]'` does not), so
 * escaping the name fixes the cause. With the cause fixed, a residual
 * zero-match is evidence the test no longer exists under that name, which is
 * `inconclusive` — and doubling the process count to guess at it is exactly the
 * amplification this file exists to stop.
 */

import { diagnosisKey, escapeTestSelector, type FailureRecord } from "./failure-artifact"

/**
 * The four outcomes, and why none of them is "flake".
 *
 * `observed-isolation-pass` is deliberately not called `flake`: one green run
 * in a different environment is ONE OBSERVATION. Calling it a flake is a causal
 * claim ("parallel load caused this") that a single sample cannot support, and
 * the old vocabulary made that claim in the type name, where nobody could see
 * it being made.
 */
export type DiagnosticOutcome =
  | "confirmed-real"
  | "observed-isolation-pass"
  | "inconclusive"
  | "infra-failed"

export interface DiagnosisBudget {
  /** Hard ceiling on diagnostic children for the whole run. */
  readonly maxChildren: number
  /** Hard ceiling on total diagnosis wall time. */
  readonly maxTotalMs: number
  /** Per-child bound, handed to the bounded-child limits. */
  readonly perChildMs: number
}

export const DEFAULT_BUDGET: DiagnosisBudget = {
  maxChildren: 12,
  maxTotalMs: 10 * 60_000,
  perChildMs: 120_000,
}

export interface DiagnosisBatch {
  readonly file: string
  /** Distinct `(testId, fingerprint)` work items this child covers. */
  readonly records: readonly FailureRecord[]
  /** The literal-escaped `-t` alternation that selects exactly these tests. */
  readonly selector: string
}

export interface DiagnosisPlan {
  readonly batches: readonly DiagnosisBatch[]
  /** Records dropped as exact duplicates of one already planned. */
  readonly deduped: readonly FailureRecord[]
  /** Records beyond the child budget — reported, never silently skipped. */
  readonly overBudget: readonly FailureRecord[]
}

/**
 * One alternation, each name escaped so `-t` treats it literally.
 *
 * Names are de-duplicated first: two failures of the same leaf under different
 * describes produce the same selector term, and repeating it would make the
 * pattern longer for no selectivity.
 */
export const batchSelector = (records: readonly FailureRecord[]): string => {
  const leaves = [...new Set(records.map((record) => record.leaf))]
  return leaves.map(escapeTestSelector).join("|")
}

export const planDiagnosis = (
  records: readonly FailureRecord[],
  budget: DiagnosisBudget = DEFAULT_BUDGET,
): DiagnosisPlan => {
  const seen = new Set<string>()
  const byFile = new Map<string, FailureRecord[]>()
  const deduped: FailureRecord[] = []
  for (const record of records) {
    const key = diagnosisKey(record)
    if (seen.has(key)) {
      deduped.push(record)
      continue
    }
    seen.add(key)
    const bucket = byFile.get(record.file) ?? []
    bucket.push(record)
    byFile.set(record.file, bucket)
  }
  const batches: DiagnosisBatch[] = []
  const overBudget: FailureRecord[] = []
  for (const [file, bucket] of [...byFile.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (batches.length >= budget.maxChildren) {
      overBudget.push(...bucket)
      continue
    }
    batches.push({ file, records: bucket, selector: batchSelector(bucket) })
  }
  return { batches, deduped, overBudget }
}

export interface ChildEvidence {
  /** `true` when the child ran to completion within its bounds. */
  readonly completed: boolean
  /** `true` when bun reported the selector matched no test. */
  readonly selectorMatchedNothing: boolean
  /** Per-test results the child actually produced, by exact test id. */
  readonly statusByTestId: ReadonlyMap<string, "pass" | "fail" | "skip">
}

/**
 * Classify ONE record against what the child actually reported about it.
 *
 * Every branch is positive evidence about THAT test id. The absence of a
 * `<testcase>` is `inconclusive`, not a pass — the whole point of reading JUnit
 * instead of the summary counts.
 */
export const classifyRecord = (
  record: FailureRecord,
  evidence: ChildEvidence,
): DiagnosticOutcome => {
  if (!evidence.completed) return "infra-failed"
  if (evidence.selectorMatchedNothing) return "inconclusive"
  const status = evidence.statusByTestId.get(record.testId)
  if (status === "fail") return "confirmed-real"
  if (status === "pass") return "observed-isolation-pass"
  return "inconclusive"
}

export interface DiagnosisRow {
  readonly file: string
  readonly testId: string
  readonly fingerprint: string
  readonly outcome: DiagnosticOutcome
  readonly detail: string
  /** The one command that reproduces the ORIGINAL failure input. */
  readonly replay: string
}

export const outcomeCounts = (
  rows: readonly DiagnosisRow[],
): Readonly<Record<DiagnosticOutcome, number>> => {
  const counts: Record<DiagnosticOutcome, number> = {
    "confirmed-real": 0,
    "observed-isolation-pass": 0,
    inconclusive: 0,
    "infra-failed": 0,
  }
  for (const row of rows) counts[row.outcome] += 1
  return counts
}

/**
 * The diagnosis REPORT type.
 *
 * `required` is the literal `"failed"`, not a computed value. That is the
 * structural half of "a retry pass must never change a required verdict": there
 * is no code path, and no combination of outcomes, that can produce any other
 * value, so a future edit that wants to promote a retry pass has to change this
 * type and its name — visibly — rather than flip a boolean.
 *
 * The schema is `quanta.flake-diagnosis.v1`, deliberately NOT the shape any
 * gate consumes. A required verdict comes from
 * `quanta.test-shard-success.v4` / `quanta.capability-result.v2`; nothing reads
 * this, so a local diagnosis cannot be mistaken for a PASS by a consumer either.
 */
export interface DiagnosisReport {
  readonly schema: "quanta.flake-diagnosis.v1"
  readonly advisory: true
  readonly required: "failed"
  readonly head: string
  readonly childrenSpawned: number
  readonly elapsedMs: number
  readonly counts: Readonly<Record<DiagnosticOutcome, number>>
  readonly rows: readonly DiagnosisRow[]
}
