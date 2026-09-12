/**
 * `tools/dev/scan-reach-authority` — what a scan-reach receipt must prove.
 *
 * # The defect
 *
 * `observedFromReceipt` validated `manifestSha256.length !== 64`. A LENGTH. Any
 * 64 hex characters passed, so a receipt could name a manifest that never
 * existed. `suite` was in the type and never compared, so a `suite: "unit"`
 * receipt — which walks a strict subset of the enrolled scan ids — was accepted
 * as proof for the closed full universe. And there was no `tier` at all, so a
 * `--suite=full --tier=pr` run, 3,938 of the 3,962 files, minted a receipt that
 * stood in for the full-universe scan.
 *
 * The consequence is specific, not theoretical: scan-reach is a FLOOR ratchet.
 * A receipt from a narrower population reports lower reach for the ids it did
 * not cover, and the consumer reads that as "the scan shrank" — or, worse,
 * accepts it and lets a guard ship with a reach nobody measured.
 *
 * # Why the consumer recomputes instead of comparing what it was given
 *
 * A receipt that carries its own authority is a receipt that certifies itself.
 * Every field here is independently derivable from the checkout, so the
 * consumer derives it and compares. The producer and the consumer call the same
 * function so the two can never drift apart in what they mean by "the current
 * manifest" — but they call it at different times, against the tree, which is
 * the part that makes it a check rather than an echo.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeExecutedPath } from "./executed-file-set"
import { testToolchainSha256 } from "./test-shard-receipt"

/**
 * The label for a run that applied NO tier selection at all.
 *
 * A run without `--tier` walks the whole discovered suite, which is the largest
 * population there is — so calling it `full` (as the producer did) names a tier
 * that is 14 files SMALLER on this tree. The consumer has no tier either: it
 * discovers the untiered universe and demands a receipt that covers it.
 */
export const UNTIERED_SCAN_POPULATION = "untiered"

/**
 * Tiers that are not narrowed BY DESIGN, and so may mint a receipt at all.
 *
 * `pr` and `prepush` are deliberately narrowed, so their runs are not evidence
 * about ids they never walked, and saying so is more explanatory than a digest
 * mismatch. Being on this list is necessary and NOT sufficient: membership is a
 * digest of the id set and is what actually decides whether a receipt covered
 * the universe the consumer needs. `full` is here because its narrowing is a
 * capability accident rather than a tier policy — and it is still rejected on
 * membership whenever it walked fewer ids.
 */
export const AUTHORITATIVE_SCAN_TIERS: readonly string[] = [
  UNTIERED_SCAN_POPULATION,
  "full",
  "nightly",
]

export interface ScanReachAuthority {
  readonly suite: "unit" | "full"
  readonly tier: string
  /** sha256 over the SORTED repo-relative ids — order-independent, unlike the
   *  manifest digest, which the runner computes in discovery order. */
  readonly membershipSha256: string
  /**
   * Digest of the TIER-ASSIGNMENT policy, not of the execution policy.
   *
   * What can change which ids a run walks is `test-policy-overrides.json`.
   * Execution knobs — intra-worker width, cache mode, the per-chunk resource
   * class — change how the same population is scheduled and are deliberately
   * NOT hashed here: invalidating a reach receipt because a worker count moved
   * would make the ratchet noisy without making it stricter.
   */
  readonly policySha256: string
  readonly capabilitySha256: string
}

/** The file that decides tier membership; missing reads as the empty policy. */
export const testPolicySha256 = (repoRoot: string): string => {
  let body = ""
  try {
    body = readFileSync(join(repoRoot, "tools", "dev", "test-policy-overrides.json"), "utf8")
  } catch {
    body = "<absent>"
  }
  return createHash("sha256").update(body).digest("hex")
}

/**
 * The id set, hashed the same way whatever shape the caller holds it in.
 *
 * `relative(repoRoot, file)` resolves a RELATIVE input against `process.cwd()`,
 * not against `repoRoot`. The producer passes absolute paths and the consumer
 * passes repo-relative ones, so the two agreed only while the process happened
 * to be started from the repository root — a gate run from a subdirectory, or a
 * worktree, silently changed the consumer's digest and nothing else's.
 * `normalizeExecutedPath` resolves against the root first, so both shapes and
 * any cwd produce one digest.
 */
export const scanReachMembershipSha256 = (repoRoot: string, files: readonly string[]): string =>
  createHash("sha256")
    .update(
      [...new Set(files.map((file) => normalizeExecutedPath(repoRoot, file)))].sort().join("\0"),
    )
    .digest("hex")

/**
 * The authority for a population the caller has already selected.
 *
 * Takes the file set rather than discovering one, so the producer describes the
 * run it actually performed and the consumer describes the run it demands — and
 * a divergence between those two shows up as a mismatch instead of as two
 * functions quietly agreeing with themselves.
 */
export const scanReachAuthorityFor = (input: {
  readonly repoRoot: string
  readonly suite: "unit" | "full"
  readonly tier: string
  readonly files: readonly string[]
  readonly capabilitySha256?: string
}): ScanReachAuthority => ({
  suite: input.suite,
  tier: input.tier,
  membershipSha256: scanReachMembershipSha256(input.repoRoot, input.files),
  policySha256: testPolicySha256(input.repoRoot),
  capabilitySha256: input.capabilitySha256 ?? testToolchainSha256(),
})

/**
 * The authority a run may record, or `undefined` when it may not record one.
 *
 * The producer's half of the decision lived inside `run-test-shards.ts`, which
 * ends in a top-level `await main()` — so no test could reach it, and the only
 * available check was to rebuild the same conditions in the test and verify the
 * copy. That is how the producer and the consumer came to disagree about what
 * `tier: "full"` meant while both halves looked right in isolation: each was
 * guarded against a fixture that shared its own assumption.
 *
 * Returning the authority rather than a boolean keeps the label the run records
 * and the label the decision was made on the same value.
 */
export const mintableScanReachAuthority = (input: {
  readonly repoRoot: string
  readonly suite: string
  /** The run's `--tier`, or `undefined` for a walk with no selection. */
  readonly tier: string | undefined
  /** The files the run actually walked, in either spelling. */
  readonly manifest: readonly string[]
  readonly capabilitySha256?: string
}): ScanReachAuthority | undefined => {
  // Only `full` covers every enrolled scan id. A `unit` run is internally
  // successful and describes a DIFFERENT population; minting for it is how a
  // floor ratchet ends up reading a subset as a regression.
  if (input.suite !== "full") return undefined
  const tier = input.tier ?? UNTIERED_SCAN_POPULATION
  if (!AUTHORITATIVE_SCAN_TIERS.includes(tier)) return undefined
  return scanReachAuthorityFor({
    repoRoot: input.repoRoot,
    suite: "full",
    tier,
    files: input.manifest,
    ...(input.capabilitySha256 === undefined ? {} : { capabilitySha256: input.capabilitySha256 }),
  })
}

/** Every way a receipt's authority can fail to be the current one. */
export type ScanReachAuthorityProblem =
  | "non-authoritative-tier"
  | "wrong-suite"
  | "wrong-tier"
  | "membership-mismatch"
  | "policy-mismatch"
  | "capability-mismatch"

/**
 * `undefined` when the receipt describes exactly the run the consumer needs.
 *
 * Ordered so the FIRST answer is the most explanatory: a `pr` receipt is
 * rejected as a narrowed tier rather than as a membership mismatch, because
 * "you ran a smaller population" and "the tree moved" send someone to two
 * different places.
 */
export const scanReachAuthorityProblem = (
  receipt: ScanReachAuthority,
  current: ScanReachAuthority,
  /**
   * Which tier LABELS this consumer will look at, defaulting to the honest
   * reading of what it is holding.
   *
   * MEASURED before this existed: the consumer recomputed the untiered universe
   * (3,965 ids) and labelled it `tier: "full"`, so a `--tier=full` receipt
   * (3,951 ids) was a `membership-mismatch` and a `--tier=nightly` receipt over
   * exactly the right 3,965 was a `wrong-tier`. No receipt any tier could mint
   * was ever acceptable, and the failure was silent: `readUsableShardReceipt`
   * returns `undefined` and the CLI quietly re-runs the whole harvest.
   *
   * A consumer with no tier of its own therefore compares POPULATIONS, which is
   * strictly stronger than comparing labels. A consumer that does name a tier
   * still gets label equality.
   */
  acceptTiers: readonly string[] = current.tier === UNTIERED_SCAN_POPULATION
    ? AUTHORITATIVE_SCAN_TIERS
    : [current.tier],
): ScanReachAuthorityProblem | undefined => {
  if (!AUTHORITATIVE_SCAN_TIERS.includes(receipt.tier)) return "non-authoritative-tier"
  if (receipt.suite !== current.suite) return "wrong-suite"
  if (!acceptTiers.includes(receipt.tier)) return "wrong-tier"
  if (receipt.membershipSha256 !== current.membershipSha256) return "membership-mismatch"
  if (receipt.policySha256 !== current.policySha256) return "policy-mismatch"
  if (receipt.capabilitySha256 !== current.capabilitySha256) return "capability-mismatch"
  return undefined
}
