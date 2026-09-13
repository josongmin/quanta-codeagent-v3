/**
 * `tools/dev/test-shard-selection` — discover, floor, select, floor again.
 *
 * # Why this is not inside the runner
 *
 * `run-test-shards.ts` ends in a top-level `await main()`, so importing it runs
 * a campaign. Everything in it was therefore unreachable from a test, and the
 * two floors it owns — the only things standing between "the corpus vanished"
 * and a green verdict over it — could be asserted only by reading the source.
 *
 * That is the exact gap this repo has a name for: a pure function tested in
 * isolation while the surface that calls it stays inert. The floors were checked
 * on a DIRTY tree, where the clean-checkout guard fires first and the tier check
 * is never reached at all, so the runtime path had no execution evidence behind
 * it.
 *
 * Extracted here with its inputs injected, so the real sequence is executable:
 * a shrunken corpus and a narrowed tier produce DIFFERENT typed failures, and a
 * test can prove it rather than describe it.
 *
 * # The two floors mean different things
 *
 *   suite floor  — over the PRE-selection universe. A suite root that still
 *                  exists but stops yielding files (a rename, a bad merge, a
 *                  directory moved under a dot prefix) shrinks the corpus
 *                  silently, and a campaign over it still prints PASS. Same
 *                  argument `scan-reach-baseline.json` makes for scanning
 *                  guards, applied to the suite the whole verdict rests on.
 *
 *   tier floor   — over the POST-selection population. A tier deliberately
 *                  selecting fewer files is a policy decision, not corpus loss.
 *
 * They were ONE check over ONE input: `SUITE_FLOORS[suite]` applied after tier
 * selection. That conflation is invisible today only because prepush, pr and
 * full resolve to the identical file set — which is itself the defect TVH-02 is
 * about. The moment PR is narrowed, an intended reduction would have been
 * reported as "the corpus shrank under the runner".
 */

import {
  loadPolicyOverrides,
  policyDigest,
  resolveTestPopulation,
  selectTestPoliciesForTier,
} from "./test-policy"
import type { SuiteName } from "./test-shard-discovery"
import {
  CORPUS_LOSS_KINDS,
  checkTierPopulation,
  type TierPopulationFile,
} from "./test-tier-population"
import { assertKnownTier } from "./verification-tier"

export interface TierSelection {
  readonly files: readonly string[]
  readonly policySha256?: string
}

export interface ShardSelectionInput {
  readonly suite: SuiteName
  readonly tier: string | undefined
  /**
   * Every file the suite roots yield, in discovery order.
   *
   * Deliberately opaque: the runner passes ABSOLUTE paths because the planner
   * buckets on them, while tier policy is keyed on repo-relative ids. `idOf`
   * bridges the two, so this module never has to know which spelling it holds —
   * an earlier draft normalised to relative here and would have silently handed
   * the planner paths it then re-relativised a second time.
   */
  readonly discovered: readonly string[]
  /** Policy id for a discovered file. Identity when they are already ids. */
  readonly idOf?: (file: string) => string
  /** Pinned minimum for this suite's PRE-selection universe. */
  readonly suiteFloor: number
  /** Committed per-tier minimums for the POST-selection population. */
  readonly tierFloors: TierPopulationFile
  /** Apply tier policy to the ids. Injected so the selection sequence is
   *  testable without loading the real override file. */
  readonly selectForTier: (ids: readonly string[], tier: string) => TierSelection
}

export interface ShardSelection {
  readonly discovered: readonly string[]
  readonly manifest: readonly string[]
  readonly tiered: TierSelection
}

/** Distinguishable at the call site, not just in the message text. */
export class CorpusLostError extends Error {
  readonly kind = "corpus-lost" as const
}

export class TierSelectionError extends Error {
  readonly kind = "tier-selection" as const
}

/**
 * Run the sequence, failing with the error that names the ACTUAL cause.
 *
 * Order matters and is the point: the universe is checked before any tier
 * policy touches it, so corpus loss can never be reported as a narrowed tier and
 * a narrowed tier can never be reported as corpus loss.
 */
export const selectShardManifest = (input: ShardSelectionInput): ShardSelection => {
  if (input.discovered.length < input.suiteFloor) {
    throw new CorpusLostError(
      `[test:shards] INVALID — suite=${input.suite} discovered ${input.discovered.length} test ` +
        `files, below the pinned floor of ${input.suiteFloor}. The corpus shrank under the ` +
        "runner; a green over it would describe a smaller universe than the one this gate claims.",
    )
  }

  if (input.tier === undefined) {
    return {
      discovered: input.discovered,
      manifest: input.discovered,
      tiered: { files: input.discovered },
    }
  }

  const idOf = input.idOf ?? ((file: string): string => file)
  const tiered = input.selectForTier(input.discovered.map(idOf), input.tier)
  const selected = new Set(tiered.files)
  // Filtered from `discovered` rather than taken from the policy layer, so the
  // manifest keeps discovery order and the planner's chunk identities stay
  // derived from the same list the floors were computed over.
  const manifest = input.discovered.filter((file) => selected.has(idOf(file)))

  const population = checkTierPopulation({
    tier: input.tier,
    suite: input.suite,
    selected: manifest.length,
    discovered: input.discovered.length,
    suiteFloor: input.suiteFloor,
    floors: input.tierFloors,
  })
  if (!population.ok) {
    // The corpus kinds carry the corpus error and every other kind the selection
    // error, so a reader is sent to the tree or to the policy file correctly.
    throw CORPUS_LOSS_KINDS.has(population.kind)
      ? new CorpusLostError(population.message)
      : new TierSelectionError(population.message)
  }

  return { discovered: input.discovered, manifest, tiered }
}

/**
 * Tier policy applied to repo-relative ids — the runner's selection, importable.
 *
 * It lived inside `run-test-shards.ts`, which ends in a top-level `await main()`
 * and cannot be imported, so an arm that wanted to check "every suite × tier the
 * runner can be asked for clears its committed floor" had to re-implement the
 * selection it was checking. Now the runner and the arm call the same function.
 */
export const tierSelectionFromPolicy = (
  relativeFiles: readonly string[],
  tier: string | undefined,
  overridesPath: string,
): TierSelection => {
  if (tier === undefined) return { files: relativeFiles }
  const overrides = loadPolicyOverrides(overridesPath).overrides
  const policies = resolveTestPopulation(relativeFiles, overrides)
  const selected = selectTestPoliciesForTier(policies, assertKnownTier(tier))
  if (selected.length === 0) {
    throw new Error(`[test:shards] INVALID — tier=${tier} selected zero files`)
  }
  return { files: selected.map(({ id }) => id), policySha256: policyDigest(policies) }
}
