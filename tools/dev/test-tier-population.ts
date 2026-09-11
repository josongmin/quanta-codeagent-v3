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
  | { readonly ok: false; readonly message: string }

/**
 * Check a tier's SELECTED population. Distinct from the suite floor in both
 * input and message, so a narrowed tier never reports as a lost corpus.
 */
export const checkTierPopulation = (input: {
  readonly tier: string
  readonly selected: number
  readonly discovered: number
  readonly floors: TierPopulationFile
}): TierPopulationVerdict => {
  const floor = input.floors.tiers[input.tier]
  if (floor === undefined) {
    return {
      ok: false,
      message:
        `[test:shards] INVALID — tier=${input.tier} has no committed population floor in ` +
        `test-tier-population.json. An unlisted tier is not a default: add it, with a reason, ` +
        "in the same diff that introduced the tier.",
    }
  }
  if (input.selected === 0) {
    return {
      ok: false,
      message:
        `[test:shards] INVALID — tier=${input.tier} selected zero of ${input.discovered} ` +
        "discovered files. The corpus is intact; the SELECTION is empty.",
    }
  }
  if (input.selected < floor.minFiles) {
    return {
      ok: false,
      message:
        `[test:shards] INVALID — tier=${input.tier} selected ${input.selected} files, below its ` +
        `committed floor of ${floor.minFiles} (${floor.reason}). The suite discovered ` +
        `${input.discovered} files, so this is a SELECTION shrink, not corpus loss. If the ` +
        "narrowing is intended, lower the floor in the same diff and say why.",
    }
  }
  if (input.selected > input.discovered) {
    return {
      ok: false,
      message:
        `[test:shards] INVALID — tier=${input.tier} selected ${input.selected} files from a ` +
        `universe of ${input.discovered}. Selection cannot exceed discovery.`,
    }
  }
  return { ok: true, floor: floor.minFiles }
}
