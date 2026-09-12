/**
 * `tools/dev/verification-matrix-population` — the population a matrix plan
 * claims, recomputed from the checkout.
 *
 * # Two defects, both found by audit
 *
 * 1. **The plan's own floor was a literal 39x below the population it guards.**
 *    `MATRIX_PLAN_FILE_FLOOR = 100` while the tier this repository plans for
 *    selects 3,941 files and `tools/dev/test-tier-population.json` already
 *    commits every tier to `minFiles: 3900`. The floor's docstring is right —
 *    "a plan over one file is shaped exactly like a real one, aggregates to a
 *    green, and proves nothing" — and a plan over 100 files, 2.5% of the tier,
 *    is the same sentence with a bigger number. The floor is now READ from the
 *    committed per-tier record instead of picked, so the matrix cannot claim
 *    coverage the repository has already refused for its own shard runner.
 *
 * 2. **`membershipSha256`, `policySha256` and `capabilitySha256` were validated
 *    for SHAPE and compared to nothing.** `planVerificationMatrix` checked
 *    `/^[0-9a-f]{64}$/` and the aggregate path compared only `tier`, so a plan
 *    carrying three arbitrary 64-hex strings passed every check and then stood
 *    in for a verdict-equality claim against the monolith. This is exactly the
 *    scan-reach defect one layer over: a receipt that carries its own authority
 *    certifies itself.
 *
 * The producer and the consumer therefore call the SAME function, at different
 * times, against the tree — which is the part that makes it a check rather than
 * an echo.
 */

import { createHash } from "node:crypto"
import { relative } from "node:path"
import { missingExternalTools } from "./external-toolchain"
import { scanReachMembershipSha256 } from "./scan-reach-authority"
import {
  loadPolicyOverrides,
  policyDigest,
  resolveTestPopulation,
  selectTestPoliciesForTier,
} from "./test-policy"
import { discoverSuiteFiles } from "./test-shard-discovery"
import { loadTierPopulationFloors, type TierPopulationFile } from "./test-tier-population"
import {
  MATRIX_PLAN_FILE_FLOOR,
  type MatrixPopulation,
  parseVerificationMatrixPlan,
  type VerificationMatrixPlan,
} from "./verification-matrix"
import { assertKnownTier } from "./verification-tier"

/**
 * The fewest files a matrix plan for `tier` may claim to cover.
 *
 * Derived from the record the shard runner already enforces, never from a
 * literal. `MATRIX_PLAN_FILE_FLOOR` survives as a floor on the FLOOR: a
 * committed record that named a tiny number would otherwise weaken this by
 * data.
 */
export const matrixPlanFileFloor = (
  tier: string,
  floors: TierPopulationFile = loadTierPopulationFloors(),
): number => {
  const committed = floors.tiers[tier]?.minFiles
  if (committed === undefined) {
    throw new Error(
      `[matrix] tier "${tier}" has no committed population floor in ` +
        "tools/dev/test-tier-population.json; refusing to plan against a floor nobody picked",
    )
  }
  return Math.max(MATRIX_PLAN_FILE_FLOOR, committed)
}

/**
 * The coverage-relevant capability difference between two hosts, and nothing else.
 *
 * # The regression this replaces
 *
 * This field was `testToolchainSha256()`, and making the comparison REAL (it was
 * previously written and compared to nothing) turned it into a plan no hosted run
 * could ever validate. That digest is over each tool's ABSOLUTE PATH plus
 * `dev:inode size mtime` — measured, `bun` contributes
 * `/Users/…/bun 16777232:885871694 63096576 1778626532000`. The matrix plans on
 * one `ubuntu-latest` VM (`full-plan`), runs `full-shard` as a matrix over
 * `fromJSON(needs.full-plan.outputs.chunks)` — a count decided at plan time, not
 * a fixed one — and aggregates on another; inodes and mtimes cannot agree across
 * fresh VMs, so every worker and the aggregator would refuse with
 * `capability-mismatch`. That is the same "a cache that can only
 * miss looks exactly like one that works" defect this module's sibling commit
 * fixed one layer up, reintroduced eighty minutes later by its own author.
 *
 * What actually changes coverage between hosts is WHICH TOOLS ARE ABSENT — a
 * worker without docker skips what a planner with docker counted. Names are
 * comparable across machines; inodes are not. Measured on this box: 27 tools
 * fingerprinted, 9 absent.
 */
export const capabilityGapSha256 = (missing: readonly string[] = missingExternalTools()): string =>
  createHash("sha256")
    .update(JSON.stringify([...missing].sort()))
    .digest("hex")

export interface CurrentMatrixPopulation {
  readonly population: MatrixPopulation
  /** Absolute paths of the selected files, in discovery order. */
  readonly files: readonly string[]
  /** The tier-assignment policies the selection came from. */
  readonly policySha256: string
}

/**
 * What a plan for `tier` must describe, computed from this checkout.
 *
 * Takes the same inputs the planner takes, so the planner has nothing of its own
 * to get wrong: it publishes what this returns.
 */
export const currentMatrixPopulation = (input: {
  readonly repoRoot: string
  readonly tier: string
  readonly policyOverridesPath: string
  readonly capabilitySha256?: string
}): CurrentMatrixPopulation => {
  const discovered = discoverSuiteFiles(input.repoRoot, "full")
  const policies = resolveTestPopulation(
    discovered.map((file) => relative(input.repoRoot, file)),
    loadPolicyOverrides(input.policyOverridesPath).overrides,
  )
  // Validated against the closed tier union rather than passed through: an
  // unknown tier selects nothing, and a plan that selects nothing aggregates to
  // a green over an empty population.
  const selectedIds = new Set(
    selectTestPoliciesForTier(policies, assertKnownTier(input.tier)).map(({ id }) => id),
  )
  const files = discovered.filter((file) => selectedIds.has(relative(input.repoRoot, file)))
  const policySha256 = policyDigest(policies)
  return {
    population: {
      tier: input.tier,
      universe: discovered.length,
      membershipSha256: scanReachMembershipSha256(input.repoRoot, [...selectedIds]),
      policySha256,
      capabilitySha256: input.capabilitySha256 ?? capabilityGapSha256(),
    },
    files,
    policySha256,
  }
}

/** Every way a plan's population can fail to be the current one. */
export type MatrixPopulationProblem =
  | "wrong-tier"
  | "universe-mismatch"
  | "membership-mismatch"
  | "policy-mismatch"
  | "capability-mismatch"

/**
 * `undefined` when the plan describes exactly the population the consumer has.
 *
 * Ordered most-explanatory first, like the scan-reach equivalent: "you planned a
 * different tier" and "the tree moved under the plan" send someone to two
 * different places.
 */
export const matrixPopulationProblem = (
  plan: MatrixPopulation,
  current: MatrixPopulation,
): MatrixPopulationProblem | undefined => {
  if (plan.tier !== current.tier) return "wrong-tier"
  if (plan.universe !== current.universe) return "universe-mismatch"
  if (plan.membershipSha256 !== current.membershipSha256) return "membership-mismatch"
  if (plan.policySha256 !== current.policySha256) return "policy-mismatch"
  if (plan.capabilitySha256 !== current.capabilitySha256) return "capability-mismatch"
  return undefined
}

/**
 * Parse a plan and check it against the checkout it is about to be used on.
 *
 * # Why this is not in the CLI
 *
 * It was, and a mutation audit walked straight through it: the only guard was
 * `expect(cli).toContain("matrixPopulationProblem(")`, so
 * `if (problem !== undefined)` could be narrowed to
 * `if (problem === "wrong-tier")` — ignoring four of the five verdicts — and
 * `matrixPlanFileFloor(tier)` could be replaced with the literal `1`, both with
 * the suite green. A string that appears in a file says nothing about what the
 * file DOES with it.
 *
 * Importable, so the arms drive the real comparison instead of grepping for it.
 */
export const loadMatrixPlanForCheckout = (input: {
  readonly raw: unknown
  readonly repoRoot: string
  readonly policyOverridesPath: string
  /** Injected only by tests that need a fixed population. */
  readonly currentPopulation?: MatrixPopulation
  readonly floors?: TierPopulationFile
}): VerificationMatrixPlan => {
  const tier = (input.raw as { population?: { tier?: unknown } }).population?.tier
  if (typeof tier !== "string") throw new Error("[matrix] plan has no population tier")
  const floor =
    input.floors === undefined ? matrixPlanFileFloor(tier) : matrixPlanFileFloor(tier, input.floors)
  const plan = parseVerificationMatrixPlan(input.raw, floor)
  const current =
    input.currentPopulation ??
    currentMatrixPopulation({
      repoRoot: input.repoRoot,
      tier: plan.population.tier,
      policyOverridesPath: input.policyOverridesPath,
    }).population
  const problem = matrixPopulationProblem(plan.population, current)
  if (problem !== undefined) {
    throw new Error(describeMatrixPopulationProblem(problem, plan.population, current))
  }
  return plan
}

/** The refusal text, naming the field and both values. */
export const describeMatrixPopulationProblem = (
  problem: MatrixPopulationProblem,
  plan: MatrixPopulation,
  current: MatrixPopulation,
): string => {
  const pairs: Record<MatrixPopulationProblem, readonly [string, string]> = {
    "wrong-tier": [plan.tier, current.tier],
    "universe-mismatch": [String(plan.universe), String(current.universe)],
    "membership-mismatch": [plan.membershipSha256, current.membershipSha256],
    "policy-mismatch": [plan.policySha256, current.policySha256],
    "capability-mismatch": [plan.capabilitySha256, current.capabilitySha256],
  }
  const [planned, now] = pairs[problem]
  return (
    `[matrix] ${problem}: the plan describes ${planned} and this checkout is ${now}. ` +
    "A plan whose population cannot be reproduced here cannot stand in for a verdict over it."
  )
}
