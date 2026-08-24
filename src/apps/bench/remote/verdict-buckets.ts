import type { OfficialGradeState } from "@/runner/batch/eval/official-grade"
import { LEGACY_BUCKET_BY_STATE } from "@/runner/batch/eval/official-grade"
import type { FullRemoteResult } from "./box-session"

export interface VerdictBuckets {
  readonly resolved: Set<string>
  readonly unresolved: Set<string>
  readonly errored: Set<string>
  readonly emptyPatch: Set<string>
}

type VerdictBucketName = keyof VerdictBuckets

const removeFromAllBuckets = (buckets: VerdictBuckets, id: string): void => {
  buckets.resolved.delete(id)
  buckets.unresolved.delete(id)
  buckets.errored.delete(id)
  buckets.emptyPatch.delete(id)
}

const placeIntoBucket = (buckets: VerdictBuckets, bucket: VerdictBucketName, id: string): void => {
  removeFromAllBuckets(buckets, id)
  buckets[bucket].add(id)
}

// If a malformed report repeats the same instance across multiple verdict arrays,
// keep one deterministic truth: later/stronger buckets win within the attempt,
// and a later attempt can overwrite an earlier attempt's bucket.
type VerdictField = "resolved" | "unresolved" | "errored" | "emptyPatch"

const VERDICT_PRECEDENCE: readonly [VerdictBucketName, VerdictField][] = [
  ["emptyPatch", "emptyPatch"],
  ["errored", "errored"],
  ["unresolved", "unresolved"],
  ["resolved", "resolved"],
]

export const absorbFullRemoteResult = (
  buckets: VerdictBuckets,
  result: Pick<FullRemoteResult, VerdictField>,
): void => {
  for (const [bucket, field] of VERDICT_PRECEDENCE) {
    for (const id of result[field] ?? []) placeIntoBucket(buckets, bucket, id)
  }
}

/** One instance as a family's OWN grader scored it. */
export interface GradedInstance {
  readonly instanceId: string
  readonly state: OfficialGradeState
}

/**
 * PMX-04 — project a family's official-state grades into the legacy four arrays.
 *
 * This lives HERE, with the rest of the bucket-placement logic, rather than in
 * the family that produced the grades. A family knows what it MEASURED (the four
 * official states); the four arrays are the remote layer's lossier wire shape,
 * and deciding how a state squeezes into them is a transport concern. Keeping it
 * here also means every family that ever grades on-box shares one answer instead
 * of each shipping its own.
 *
 * The mapping itself is IMPORTED from PMX-03's canonical table — notably
 * `ambiguous → errored`, never `unresolved`: a grader that declined to decide has
 * observed no model failure, and scoring it as one would flatter the denominator.
 *
 * `emptyPatch` stays empty: "the model submitted nothing" is a property of the
 * PREDICTIONS, not of a grade row, and an empty patch is graded as a real model
 * miss rather than being siphoned out of the measurement.
 */
export const bucketsFromGradedInstances = (
  graded: readonly GradedInstance[],
  assignedInstanceIds?: readonly string[],
): {
  resolved: string[]
  unresolved: string[]
  errored: string[]
  emptyPatch: string[]
} => {
  const out = {
    resolved: [] as string[],
    unresolved: [] as string[],
    errored: [] as string[],
    emptyPatch: [] as string[],
  }
  const reported = new Set<string>()
  for (const g of graded) {
    reported.add(g.instanceId)
    out[LEGACY_BUCKET_BY_STATE[g.state]].push(g.instanceId)
  }

  // RECONCILE against the assigned set. The pinned evaluator iterates the
  // PREDICTIONS and looks golden up by id, skipping an id it cannot find
  // (`test_run.py`: `if golden_entry is None: continue`) — so an instance can be
  // submitted and come back with no row at all. The same happens when the
  // evaluator dies part-way, or when patch-gen produced no predictions.
  //
  // Without this, those instances would leave the chunk's accounting silently,
  // shrinking the denominator so the survivors look like a larger share of a
  // smaller set while the run still reads as clean. That is strictly worse than
  // a reported failure.
  //
  // They are `errored`, never `unresolved`: "the evaluator produced no verdict"
  // is a claim about the INFRASTRUCTURE, and filing it against the model would
  // assert a measurement that never happened.
  //
  // Optional so every family that grades inline is byte-identical.
  for (const id of assignedInstanceIds ?? []) {
    if (!reported.has(id)) out.errored.push(id)
  }
  return out
}
