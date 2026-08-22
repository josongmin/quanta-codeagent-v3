/**
 * LEAF — CAMPAIGN COVERAGE after instance-aware relaunch.
 *
 * `remote/**` owns "which of the instances I promised to run actually came
 * back". Historically that answer was subtracted out of the four legacy id
 * arrays, which is fine while those arrays are the whole truth — and wrong the
 * moment a family grades through an official out-of-process grader, because the
 * four arrays cannot say `ambiguous` and cannot say `missing` at all.
 *
 * So: when the attempts carried PMX-03 receipts, coverage is derived from the
 * MERGED receipt via {@link deriveMissingInstanceIds} — the one place in the
 * codebase allowed to compute `missing` — with the campaign's `expected` set as
 * the denominator, so a chunk whose box died still counts against the campaign
 * instead of quietly shrinking it. When they did not, the historical legacy
 * subtraction is returned verbatim and every non-official lane is byte-identical.
 *
 * A REFUSED merge (a duplicate disposition across attempts, two evaluator
 * builds) is surfaced, never downgraded to "there was no receipt": silently
 * dropping a receipt that fails closed is how a campaign ends up reported
 * through the lossier path precisely when something went wrong.
 */
import {
  deriveMissingInstanceIds,
  mergeOfficialGradeReceipts,
  type OfficialGradeReceipt,
  type OfficialGradeReceiptFailure,
} from "@/runner/batch/eval/official-grade"

export interface RelaunchCoverage {
  /** The merged campaign receipt, when the attempts produced any and they merged. */
  readonly officialGrade?: OfficialGradeReceipt
  /** Why the merge was refused, when it was. Mutually exclusive with the above. */
  readonly officialGradeFailures?: readonly OfficialGradeReceiptFailure[]
  /** Expected instances that earned no verdict. Receipt-derived when possible. */
  readonly missing: readonly string[]
}

/**
 * Instances a receipt has ALREADY spoken about. Used to decide what a relaunch
 * still has to retry, unioned with the legacy coverage so the retry set can only
 * ever shrink — never grow because one of the two views was blind to a row.
 */
export const instancesCoveredByReceipts = (
  receipts: readonly OfficialGradeReceipt[],
): ReadonlySet<string> => {
  const covered = new Set<string>()
  for (const receipt of receipts) {
    for (const id of receipt.dispositionsByInstanceId.keys()) covered.add(id)
  }
  return covered
}

export const resolveRelaunchCoverage = (args: {
  readonly expected: readonly string[]
  readonly receipts: readonly OfficialGradeReceipt[]
  /** What the legacy four-bucket subtraction concluded. The fallback, and the
   *  answer for every family that carries no receipt. */
  readonly legacyMissing: readonly string[]
  /**
   * Instances the four LEGACY BUCKETS alone vouch for — the retry loop's own
   * `covered` set, WITHOUT the receipt union.
   *
   * It exists for exactly one path: a REFUSED merge. `legacyMissing` is the
   * relaunch loop's retry set, and that set deliberately counts an instance as
   * covered when a RECEIPT spoke about it. When the merge then fails closed —
   * a duplicate disposition across attempts, two evaluator builds — those are
   * the very receipts being rejected, so returning the retry set publishes
   * coverage that no surviving evidence supports. On that path `missing` is
   * derived from the assigned set minus what the buckets can still vouch for.
   */
  readonly legacyCovered: readonly string[]
}): RelaunchCoverage => {
  if (args.receipts.length === 0) return { missing: [...args.legacyMissing] }
  const merged = mergeOfficialGradeReceipts({
    receipts: args.receipts,
    additionalAssignedInstanceIds: args.expected,
  })
  if (!merged.ok) {
    const covered = new Set(args.legacyCovered)
    return {
      officialGradeFailures: merged.failures,
      missing: args.expected.filter((id) => !covered.has(id)),
    }
  }
  return {
    officialGrade: merged.receipt,
    missing: [...deriveMissingInstanceIds(merged.receipt)],
  }
}
