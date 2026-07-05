/**
 * Observation metrics — failure-taxonomy classifier (jul-6, Stream S4).
 * Design SSOT: `docs/plans/jul-6-observation-providers/README.md` §실험 설계
 * ("실패 taxonomy").
 *
 * Pure fn over the SAME inputs as the usage rates (trajectory events + bundle +
 * final-patch/pass metadata). Returns the matched labels (0..n) — a run can
 * exhibit several failure modes at once, and a PASSED run may still match none.
 * No IO / env / `@/llm`.
 */

import type { ObservationBundle } from "../fragment"
import { EDIT_TOOLS, type MetricEvent, pathMatchesAnyOwner, toolFilePath, toolName } from "./event"
import { bundleOwnerPaths, hintFollowWithoutVerifyRate, type MetricInputs } from "./usage-metrics"

export type FailureLabel =
  | "LOCALIZATION_WRONG_OWNER"
  | "HINT_OVERTRUST"
  | "PATCH_TOO_NARROW"
  | "PATCH_TOO_WIDE"
  | "UNRELATED_DIFF"
  | "STOP_TOO_EARLY"
  | "STOP_TOO_LATE"

/** Tuning knobs for the taxonomy — explicit so no magic number hides in a branch. */
export interface TaxonomyOptions {
  /**
   * A run whose trailing tool calls are ≥ this many consecutive verify/bash
   * calls with no edit is "still churning at the wall" ⇒ STOP_TOO_LATE.
   * Mirrors the existing failure-classifier's `VERIFY_LOOP_THRESHOLD` intent.
   */
  readonly verifyLoopThreshold: number
}

const DEFAULTS: TaxonomyOptions = { verifyLoopThreshold: 4 }

const editedPaths = (events: readonly MetricEvent[]): readonly string[] => {
  const out: string[] = []
  for (const e of events) {
    const name = toolName(e)
    if (name === undefined || !EDIT_TOOLS.has(name)) continue
    const p = toolFilePath(e)
    if (p !== undefined) out.push(p)
  }
  return out
}

const distinctEditedFiles = (events: readonly MetricEvent[]): readonly string[] => [
  ...new Set(editedPaths(events)),
]

/** Trailing run of consecutive verify-ish (`bash`/`test_runner`) calls, no edit between. */
const trailingVerifyChurn = (events: readonly MetricEvent[]): number => {
  const names: string[] = []
  for (const e of events) {
    const n = toolName(e)
    if (n !== undefined) names.push(n)
  }
  let trailing = 0
  for (let i = names.length - 1; i >= 0; i--) {
    const n = names[i]
    if (n === "bash" || n === "test_runner" || n === "testrun") trailing++
    else break
  }
  return trailing
}

/**
 * Derived facts shared by all label detectors — computed ONCE so each detector
 * is a small pure predicate over the same normalized view (keeps the orchestrator
 * flat and each rule independently testable).
 */
interface TaxonomyFacts {
  readonly owners: readonly string[]
  readonly edits: readonly string[]
  /** `undefined` ⇒ the success patch is unknown (run failed / no patch). */
  readonly patch: readonly string[] | undefined
  readonly passed: boolean
  readonly trailingChurn: number
}

/** One label detector: pure predicate over the shared facts. `null` label rule
 *  entries let a detector opt out inline; the orchestrator filters them. */
type Detector = (f: TaxonomyFacts, o: TaxonomyOptions) => FailureLabel | null

// LOCALIZATION_WRONG_OWNER — edited files, NONE in the success patch. Needs a patch.
const detectWrongOwner: Detector = (f) =>
  f.patch !== undefined &&
  f.edits.length > 0 &&
  !f.edits.some((e) => pathMatchesAnyOwner(e, f.patch as readonly string[]))
    ? "LOCALIZATION_WRONG_OWNER"
    : null

// HINT_OVERTRUST — followed a suggested owner WITHOUT verify AND that owner is
// NOT in the success patch (design A1 killer). Needs a patch to prove "wrong".
const detectHintOvertrust =
  (fwvFollowedWithoutVerify: boolean): Detector =>
  (f) => {
    if (!fwvFollowedWithoutVerify || f.patch === undefined) return null
    const patch = f.patch
    const followedButWrong = f.owners.some(
      (o) => f.edits.some((e) => pathMatchesAnyOwner(e, [o])) && !pathMatchesAnyOwner(o, patch),
    )
    return followedButWrong ? "HINT_OVERTRUST" : null
  }

// PATCH_TOO_NARROW — failed, edited a strict SUBSET of the success-patch files.
const detectTooNarrow: Detector = (f) => {
  if (f.passed || f.patch === undefined || f.edits.length === 0) return null
  const editedInPatch = f.edits.filter((e) => pathMatchesAnyOwner(e, f.patch as readonly string[]))
  return editedInPatch.length > 0 && editedInPatch.length < f.patch.length
    ? "PATCH_TOO_NARROW"
    : null
}

// PATCH_TOO_WIDE — edited MORE distinct files than the patch touched.
const detectTooWide: Detector = (f) =>
  f.patch !== undefined && f.patch.length > 0 && f.edits.length > f.patch.length
    ? "PATCH_TOO_WIDE"
    : null

// UNRELATED_DIFF — an edited file is neither a suggested owner NOR in the patch.
const detectUnrelated: Detector = (f) =>
  f.patch !== undefined &&
  f.edits.length > 0 &&
  f.edits.some(
    (e) =>
      !pathMatchesAnyOwner(e, f.patch as readonly string[]) && !pathMatchesAnyOwner(e, f.owners),
  )
    ? "UNRELATED_DIFF"
    : null

// STOP_TOO_EARLY — failed with NO edit at all.
const detectStopEarly: Detector = (f) =>
  !f.passed && f.edits.length === 0 ? "STOP_TOO_EARLY" : null

// STOP_TOO_LATE — failed while still churning verify/bash at the wall.
const detectStopLate: Detector = (f, o) =>
  !f.passed && f.trailingChurn >= o.verifyLoopThreshold ? "STOP_TOO_LATE" : null

/**
 * Classify the failure modes of one instance. Returns matched labels (0..n).
 *
 * A PASSED run generally matches nothing, EXCEPT modes that are still observable
 * on success (e.g. UNRELATED_DIFF — a passing patch that also touched unrelated
 * files). Callers typically only classify FAILED runs, but the fn is total.
 */
export const classifyFailure = (
  events: readonly MetricEvent[],
  bundle: ObservationBundle,
  inputs: MetricInputs,
  options: TaxonomyOptions = DEFAULTS,
): readonly FailureLabel[] => {
  const fwv = hintFollowWithoutVerifyRate(events, bundle)
  const facts: TaxonomyFacts = {
    owners: bundleOwnerPaths(bundle),
    edits: distinctEditedFiles(events),
    patch: inputs.successPatchFiles?.map((p) => p.replaceAll("\\", "/")),
    passed: inputs.passed === true,
    trailingChurn: trailingVerifyChurn(events),
  }
  const detectors: readonly Detector[] = [
    detectWrongOwner,
    detectHintOvertrust(fwv.applicable && fwv.num > 0),
    detectTooNarrow,
    detectTooWide,
    detectUnrelated,
    detectStopEarly,
    detectStopLate,
  ]
  const labels = new Set<FailureLabel>()
  for (const detect of detectors) {
    const label = detect(facts, options)
    if (label !== null) labels.add(label)
  }
  return [...labels]
}
