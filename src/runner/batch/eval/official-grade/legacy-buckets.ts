/**
 * PMX-03 — the ONE compatibility boundary between the official-grade receipt
 * and the legacy `{resolved, unresolved, errored, emptyPatch}` arrays.
 *
 * This is a PROJECTION, in one direction only. The four arrays are a strictly
 * lossier view of the receipt: they have no way to say `ambiguous` (the grader
 * declined) and no way at all to say `missing` (never graded). Historically
 * those rows got quietly folded into `unresolved` — i.e. counted as model
 * failures — which is exactly the flattering-denominator bug PMX-03 exists to
 * kill.
 *
 * So: the projection is computed on demand, frozen, and reports what it had to
 * drop. There is no inverse function and nothing here writes back.
 */
import { deriveMissingInstanceIds } from "./receipt"
import type { OfficialGradeReceipt, OfficialGradeState } from "./types"

export type LegacyBucketName = "resolved" | "unresolved" | "errored" | "emptyPatch"

/**
 * State → legacy bucket. `Record<OfficialGradeState, …>` makes a new state a
 * COMPILE error here rather than an instance that silently vanishes from all
 * four arrays.
 *
 * `ambiguous` maps to `errored`, NOT `unresolved`: a grader that declined to
 * decide has not observed a model failure, and putting it in `unresolved`
 * would score it against the model.
 */
export const LEGACY_BUCKET_BY_STATE: Record<OfficialGradeState, LegacyBucketName> = {
  resolved: "resolved",
  model_miss: "unresolved",
  infra_invalid: "errored",
  ambiguous: "errored",
}

export interface LegacyBucketProjection {
  readonly resolved: readonly string[]
  readonly unresolved: readonly string[]
  readonly errored: readonly string[]
  readonly emptyPatch: readonly string[]
  /**
   * Assigned ids the four legacy arrays CANNOT represent. Non-empty means the
   * projection is lossy and a legacy consumer is under-reporting the campaign.
   */
  readonly droppedMissing: readonly string[]
}

/**
 * Derive the legacy four-array view. Frozen so a caller cannot mutate it and
 * imagine the receipt changed.
 *
 * `emptyPatch` keeps its legacy meaning — "the model submitted nothing" — and
 * therefore only ever siphons instances OUT of `unresolved`. A resolved or
 * errored instance stays in its state bucket even if the prediction was empty,
 * because those are claims about grading, not about submission.
 */
export const projectLegacyBuckets = (receipt: OfficialGradeReceipt): LegacyBucketProjection => {
  const resolved: string[] = []
  const unresolved: string[] = []
  const errored: string[] = []
  const emptyPatch: string[] = []

  for (const id of receipt.assignedInstanceIds) {
    const d = receipt.dispositionsByInstanceId.get(id)
    if (d === undefined) continue
    const bucket = LEGACY_BUCKET_BY_STATE[d.state]
    if (bucket === "unresolved" && d.predictionEmpty === true) emptyPatch.push(id)
    else if (bucket === "resolved") resolved.push(id)
    else if (bucket === "unresolved") unresolved.push(id)
    else errored.push(id)
  }

  return Object.freeze({
    resolved: Object.freeze(resolved),
    unresolved: Object.freeze(unresolved),
    errored: Object.freeze(errored),
    emptyPatch: Object.freeze(emptyPatch),
    droppedMissing: Object.freeze([...deriveMissingInstanceIds(receipt)]),
  })
}
