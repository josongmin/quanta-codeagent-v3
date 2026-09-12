/**
 * `tools/dev/test-tier-population` — the committed floor on what each TIER
 * selects, kept separate from the floor on what the SUITE discovers.
 *
 * # Two different failures wearing one error
 *
 * The runner had a single check:
 *
 *     const floor = SUITE_FLOORS[opts.suite]        // 3_600 for `full`
 *     if (manifest.length < floor) throw "the corpus shrank under the runner"
 *
 * but `manifest` is the list AFTER tier selection. So the one message covered
 * two unrelated events:
 *
 *   1. the suite roots stopped yielding files — a rename, a bad merge, a
 *      directory moved under a dot prefix. Real corpus loss, and the reason the
 *      floor exists.
 *   2. a tier deliberately selecting fewer files than the suite discovered.
 *
 * Today (2) cannot happen, because `prepush`, `pr` and `full` resolve to the
 * identical 3,932-file set — that identity is itself the defect TVH-02 is
 * about. The moment PR is narrowed to exclude capability-gated tests, an
 * intentional reduction below 3,600 would be reported as "the corpus shrank
 * under the runner", which is false and points at the wrong file.
 *
 * So the suite floor now guards the PRE-SELECTION universe, where corpus loss
 * actually shows up, and this record guards the POST-SELECTION population, with
 * its own message. A tier that selects nothing, or far less than it committed
 * to, is a selection defect and says so.
 *
 * # Why the numbers live in a committed record
 *
 * A tier population is expected to change when membership policy changes, so
 * pinning it in code would make every legitimate policy edit look like a runner
 * edit. It is a reviewable data file with a reason per tier, on the same
 * discipline as `scan-reach-baseline.json`: raising it when the population
 * genuinely grows is routine; lowering it is a deliberate line in the same diff
 * that narrowed the tier.
 *
 * An unlisted tier is a HARD failure, not a default. A default would silently
 * absorb exactly the shrink this record exists to notice.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface TierPopulationFloor {
  /** Fewest files this tier may select before it is a selection defect. */
  readonly minFiles: number
  /** Why this number, in one line. Empty is rejected. */
  readonly reason: string
}

export interface TierPopulationFile {
  readonly schema: "quanta.test-tier-population.v1"
  readonly tiers: Readonly<Record<string, TierPopulationFloor>>
}

export const TIER_POPULATION_PATH = join(import.meta.dir, "test-tier-population.json")

export const loadTierPopulationFloors = (
  path: string = TIER_POPULATION_PATH,
): TierPopulationFile => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as TierPopulationFile
  if (parsed.schema !== "quanta.test-tier-population.v1") {
    throw new Error(`unknown tier population schema: ${String(parsed.schema)}`)
  }
  const tiers = parsed.tiers
  if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) {
    throw new Error("tier population: `tiers` must be an object")
  }
  // Anti-vacuum: an emptied record would turn every tier check below into a
  // silent pass, which is the shape this file exists to remove.
  if (Object.keys(tiers).length === 0) {
    throw new Error("tier population: no tiers declared — refusing to validate over nothing")
  }
  for (const [tier, floor] of Object.entries(tiers)) {
    if (!Number.isSafeInteger(floor.minFiles) || floor.minFiles < 1) {
      throw new Error(`tier population: ${tier} has a non-positive minFiles`)
    }
    if (typeof floor.reason !== "string" || floor.reason.trim() === "") {
      throw new Error(`tier population: ${tier} has no reason`)
    }
  }
  return parsed
}

export type TierPopulationVerdict =
  | { readonly ok: true; readonly floor: number }
  | {
      readonly ok: false
      readonly kind:
        | "no-floor"
        | "empty-selection"
        | "narrowed"
        | "universe-below-tier-floor"
        | "suite-narrower-than-tier-floor"
        | "over-selected"
      readonly message: string
    }

/**
 * Which suite these floors were measured over, decided by the CALLER.
 *
 * Every `reason` in `test-tier-population.json` is phrased against the
 * UNIVERSE — "universe minus 6 nightly-exhaustive minus 17 lane-gated
 * capability files" — so the numbers only mean what they say for the suite that
 * IS the universe.
 *
 * This was a bare `TIER_FLOOR_UNIVERSE_SUITE = "full" as const` with no type or
 * runtime relation to `SuiteName`. An audit showed the arm could not see it
 * drift: renaming the constant to `"fulll"` left EVERY arm green, including all
 * three paired controls, while production `suite: "full"` silently took the
 * narrow branch for the whole tree. The arm was sensitive to exactly the three
 * values its loop happened to iterate.
 *
 * `selectShardManifest` holds `suite: SuiteName`, so it decides this with a
 * comparison the compiler checks, and a typo is a type error rather than a
 * verdict change.
 */
export type TierPopulationScope = "universe" | "narrower-suite"

/**
 * Check a tier's SELECTED population. Distinct from the suite floor in both
 * input and message, so a narrowed tier never reports as a lost corpus.
 *
 * …and, since the audit, not the other way round either. The shortfall branch
 * had `discovered` in hand and never compared it: it printed "this is a
 * SELECTION shrink, not corpus loss" unconditionally. The suite floor for `full`
 * is 3,600 and the tier floor is 3,900, so any corpus loss landing in that
 * 300-file band was reported with a message that explicitly DENIED corpus loss —
 * the exact mis-attribution the split exists to remove, pointing the other way.
 */
export const checkTierPopulation = (input: {
  readonly tier: string
  readonly selected: number
  readonly discovered: number
  readonly floors: TierPopulationFile
  /**
   * Which suite was discovered. Optional, and absent means "the universe" —
   * which is what every caller meant before this parameter existed.
   */
  readonly suite?: string
  /** Universe or a narrower suite. Absent means universe, as above. */
  readonly scope?: TierPopulationScope
  /**
   * This suite's committed PRE-selection floor, so the refusal can say what its
   * claim about the corpus rests on instead of asserting one it never checked.
   */
  readonly suiteFloor?: number
}): TierPopulationVerdict => {
  const floor = input.floors.tiers[input.tier]
  if (floor === undefined) {
    return {
      ok: false,
      kind: "no-floor",
      message:
        `[test:shards] INVALID — tier=${input.tier} has no committed population floor in ` +
        `test-tier-population.json. An unlisted tier is not a default: add it, with a reason, ` +
        "in the same diff that introduced the tier.",
    }
  }
  if (input.selected > input.discovered) {
    return {
      ok: false,
      kind: "over-selected",
      message:
        `[test:shards] INVALID — tier=${input.tier} selected ${input.selected} files from a ` +
        `universe of ${input.discovered}. Selection cannot exceed discovery.`,
    }
  }
  if (input.selected === 0) {
    return {
      ok: false,
      kind: "empty-selection",
      message:
        `[test:shards] INVALID — tier=${input.tier} selected zero of ${input.discovered} ` +
        "discovered files. The corpus is intact; the SELECTION is empty.",
    }
  }
  if (input.selected >= floor.minFiles) return { ok: true, floor: floor.minFiles }

  // BELOW THE FLOOR — now say WHICH of the THREE things happened.
  //
  // The third was invisible and its message was actively wrong. A narrower
  // suite selects every file it discovered and still lands under a floor
  // measured over the universe, which looks EXACTLY like corpus loss:
  // `selected === discovered < floor`. MEASURED against these floors, three of
  // the four shard-runner entry points in package.json hit it and can never
  // run — `--suite=core` selects 3583, `--suite=unit` 3258 and
  // `--suite=integration` 394, all against a floor of 3900 — and each was told
  // "the universe itself shrank past what this tier promises ... fix the
  // corpus", sending the reader to look for a loss that is not there.
  if (input.scope === "narrower-suite") {
    // NOT "the corpus is intact" — that was asserted and never checked, and for
    // `--suite=integration` (floor 330, tier floor 3900) it was printed
    // unconditionally, including after a collapse from 394 files to 330. What
    // IS checked is the suite's own pre-selection floor, which the caller
    // enforces before reaching here, so the claim names it.
    const rests =
      input.suiteFloor === undefined
        ? "The suite's own pre-selection floor was checked separately"
        : `The suite's own pre-selection floor of ${input.suiteFloor} was cleared by the ` +
          `${input.discovered} discovered files, so this is not corpus loss BY THAT MEASURE`
    return {
      ok: false,
      kind: "suite-narrower-than-tier-floor",
      message:
        `[test:shards] INVALID — suite=${input.suite ?? "<unnamed>"} discovered ` +
        `${input.discovered} files and tier=${input.tier} selected ${input.selected} of them, ` +
        `below the committed floor of ${floor.minFiles}. ${rests}. That tier floor is measured ` +
        `over the whole discovered universe (${floor.reason}), so it does not describe a ` +
        "narrower suite, and comparing the two is meaningless rather than failing. Run this " +
        "tier against the universe suite, or commit a floor for this suite/tier pair. Do not " +
        "lower the universe floor to make this pass.",
    }
  }
  if (input.selected === input.discovered) {
    return {
      ok: false,
      kind: "universe-below-tier-floor",
      message:
        `[test:shards] INVALID — tier=${input.tier} selected all ${input.selected} discovered ` +
        `files, and that is still below its committed floor of ${floor.minFiles} ` +
        `(${floor.reason}). NOTHING was narrowed: the universe itself shrank past what this ` +
        "tier promises. The suite floor did not catch it because it sits lower — fix the corpus, " +
        "or lower both floors together and say why.",
    }
  }
  return {
    ok: false,
    kind: "narrowed",
    message:
      `[test:shards] INVALID — tier=${input.tier} selected ${input.selected} files, below its ` +
      `committed floor of ${floor.minFiles} (${floor.reason}). The suite discovered ` +
      `${input.discovered} files, so this is a SELECTION shrink, not corpus loss. If the ` +
      "narrowing is intended, lower the floor in the same diff and say why.",
  }
}
