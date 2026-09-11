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
import { join, relative } from "node:path"
import { testToolchainSha256 } from "./test-shard-receipt"

/**
 * Tiers whose population is the whole enrolled universe.
 *
 * `pr` and `prepush` are narrowed by design, so their runs are not evidence
 * about ids they never walked. Only these may mint a scan-reach receipt.
 */
export const AUTHORITATIVE_SCAN_TIERS: readonly string[] = ["full", "nightly"]

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

export const scanReachMembershipSha256 = (repoRoot: string, files: readonly string[]): string =>
  createHash("sha256")
    .update([...new Set(files.map((file) => relative(repoRoot, file)))].sort().join("\0"))
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
): ScanReachAuthorityProblem | undefined => {
  if (!AUTHORITATIVE_SCAN_TIERS.includes(receipt.tier)) return "non-authoritative-tier"
  if (receipt.suite !== current.suite) return "wrong-suite"
  if (receipt.tier !== current.tier) return "wrong-tier"
  if (receipt.membershipSha256 !== current.membershipSha256) return "membership-mismatch"
  if (receipt.policySha256 !== current.policySha256) return "policy-mismatch"
  if (receipt.capabilitySha256 !== current.capabilitySha256) return "capability-mismatch"
  return undefined
}
