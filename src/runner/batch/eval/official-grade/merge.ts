/**
 * PMX-03/04 — the ONE way two official-grade receipts become one.
 *
 * ## Why merging needs its own owner
 *
 * A campaign is not one grader run. It is K chunks across N boxes, plus
 * instance-aware relaunches for the chunks a spot reclaim ate. Every one of
 * those produces its own receipt with its own `assignedInstanceIds`. The
 * tempting shortcut — build a `Map` and `set()` every disposition as it arrives —
 * is exactly the bug PMX-03 exists to prevent: the LAST chunk to report an
 * instance silently wins, and a re-graded instance can flip a `model_miss` into
 * a `resolved` with nothing in the artifact to show it happened.
 *
 * So merging is defined as: union the DENOMINATOR, concatenate the
 * DISPOSITIONS, and hand the whole thing back to {@link buildOfficialGradeReceipt}.
 * Every rule that guards a single receipt (duplicates, unassigned ids, unknown
 * states, derived `gradingValid`) therefore guards the merged one too, and a
 * duplicate across chunks FAILS CLOSED rather than resolving itself.
 *
 * ## `additionalAssignedInstanceIds` — the campaign denominator
 *
 * The chunks only know what THEY were given. A chunk whose box died reports
 * nothing at all, so a merge over chunk receipts alone would quietly shrink the
 * campaign to the instances that happened to come back — the flattering
 * denominator again. The caller passes the set the campaign is accountable for
 * (full-remote passes its `expected` set), it is unioned in, and
 * `deriveMissingInstanceIds` then names the gap.
 *
 * ## Evaluator identity
 *
 * Merging receipts from DIFFERENT evaluator builds would produce a campaign
 * score with no single replayable grader, so the identity fields must agree or
 * the merge is refused. The surviving observation is the WORST one seen (no
 * exit status beats a non-zero exit beats a clean exit), verbatim from the
 * chunk that produced it — the merge never fabricates a synthetic run.
 */
import { buildOfficialGradeReceipt } from "./receipt"

/**
 * The union of every chunk's image pins, or `undefined` when no chunk carried
 * any — so a campaign of graders that captured none serializes exactly as it
 * did before this field existed. A repeated instance keeps its FIRST pin and
 * the receipt builder refuses the duplicate if the two disagree.
 */
const mergedImages = (
  receipts: readonly OfficialGradeReceipt[],
): readonly OfficialGradeImageRef[] | undefined => {
  const out: OfficialGradeImageRef[] = []
  const seen = new Set<string>()
  for (const receipt of receipts) {
    for (const image of receipt.images ?? []) {
      if (seen.has(image.instanceId)) continue
      seen.add(image.instanceId)
      out.push(image)
    }
  }
  return out.length === 0 ? undefined : out
}

import type {
  OfficialGradeDisposition,
  OfficialGradeEvaluatorMeta,
  OfficialGradeImageRef,
  OfficialGradeReceipt,
  OfficialGradeReceiptResult,
} from "./types"

export interface MergeOfficialGradeReceiptsInput {
  /** Chunk/attempt receipts, in the order they were produced. */
  readonly receipts: readonly OfficialGradeReceipt[]
  /**
   * Ids the CAMPAIGN is accountable for regardless of which chunks came back.
   * Unioned into the denominator; never adds a disposition.
   */
  readonly additionalAssignedInstanceIds?: readonly string[] | undefined
}

/** Identity fields that must agree for two receipts to describe one campaign. */
const identityOf = (meta: OfficialGradeEvaluatorMeta): string =>
  [meta.evaluatorId, meta.upstreamCommit, meta.evaluatorPath, meta.evaluatorSha256].join("\x00")

/** No exit status at all is the worst evidence, then a non-zero exit, then 0. */
const severity = (meta: OfficialGradeEvaluatorMeta): number =>
  meta.exitCode === null ? 2 : meta.exitCode === 0 ? 0 : 1

/**
 * Merge K receipts into one, or refuse. `ok === false` carries the SAME
 * accumulated failure vocabulary a single receipt would, so a caller has one
 * thing to narrow on.
 */
export const mergeOfficialGradeReceipts = (
  input: MergeOfficialGradeReceiptsInput,
): OfficialGradeReceiptResult => {
  const first = input.receipts[0]
  if (first === undefined) {
    return {
      ok: false,
      failures: [
        {
          code: "receipt_unparseable",
          message: "cannot merge zero official-grade receipts — there is no evaluator to attribute",
        },
      ],
    }
  }

  const identity = identityOf(first.evaluator)
  const conflicting = input.receipts.find((r) => identityOf(r.evaluator) !== identity)
  if (conflicting !== undefined) {
    return {
      ok: false,
      failures: [
        {
          code: "evaluator_meta_invalid",
          message:
            "refusing to merge official-grade receipts produced by DIFFERENT evaluator builds " +
            `("${first.evaluator.evaluatorId}"@${first.evaluator.upstreamCommit} vs ` +
            `"${conflicting.evaluator.evaluatorId}"@${conflicting.evaluator.upstreamCommit}) — ` +
            "a campaign score with two graders has no single replayable authority",
        },
      ],
    }
  }

  // Denominator: first-seen order across chunks, then whatever the campaign
  // declares. Duplicates are dropped HERE (a chunk boundary legitimately repeats
  // nothing, but two chunks may both name an id in their assigned set) —
  // `buildOfficialGradeReceipt` would otherwise refuse the union as duplicated.
  const assigned: string[] = []
  const seenAssigned = new Set<string>()
  const pushAssigned = (id: string): void => {
    if (seenAssigned.has(id)) return
    seenAssigned.add(id)
    assigned.push(id)
  }
  for (const r of input.receipts) for (const id of r.assignedInstanceIds) pushAssigned(id)
  for (const id of input.additionalAssignedInstanceIds ?? []) pushAssigned(id)

  // Dispositions: concatenated, NOT de-duplicated. A repeat is a real defect and
  // the builder must be the one to say so.
  const dispositions: OfficialGradeDisposition[] = []
  for (const r of input.receipts) {
    for (const id of r.assignedInstanceIds) {
      const d = r.dispositionsByInstanceId.get(id)
      if (d !== undefined) dispositions.push(d)
    }
  }

  const worst = input.receipts.reduce((a, b) =>
    severity(b.evaluator) > severity(a.evaluator) ? b : a,
  )
  // The pins from EVERY chunk, in assigned order, de-duplicated by instance.
  // Dropping them made the CAMPAIGN receipt — the artifact downstream surfaces
  // actually read — carry no provenance at all, while each per-chunk file had
  // it. This header's own rule ("every rule that guards a single receipt guards
  // the merged one too") could not hold for `image_ref_invalid` until now.
  const images = mergedImages(input.receipts)
  return buildOfficialGradeReceipt({
    assignedInstanceIds: assigned,
    dispositions,
    evaluator: worst.evaluator,
    ...(images === undefined ? {} : { images }),
  })
}
