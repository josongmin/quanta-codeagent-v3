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
import type { SuiteName } from "./test-shard-discovery"

export interface TierPopulationFloor {
  /** Fewest files this tier may select before it is a selection defect. */
  readonly minFiles: number
  /** Why this number, in one line. Empty is rejected. */
  readonly reason: string
}

/** A narrower suite's floor for one tier, with the measured count it derives from. */
export interface NarrowSuiteFloor extends TierPopulationFloor {
  /** Files this suite selected at this tier when measured. The floor derives from it. */
  readonly selected: number
}

export type NarrowSuiteName = Exclude<SuiteName, "full">

/**
 * # Per-suite floors, and why they are derived rather than picked
 *
 * The tier floors below are measured over the UNIVERSE, and they were applied to
 * every suite. A narrower suite selects every file it discovered and still lands
 * under 3,900, so all TWELVE narrow suite × tier pairs refused — `bun run
 * test:unit`, `test:unit:ci` and `test:integration` could never run, while
 * `AGENT_CORE.md` and `AGENTS.md` present them as the canonical commands.
 *
 * A picked number per pair would be twelve new free parameters. Instead each
 * narrow floor gives up exactly its SHARE of its parent's committed slack:
 *
 *   minFiles = selected − floor((parentSelected − parentFloor) × selected / parentSelected)
 *
 * `core` and `integration` partition the universe, so rounding each share DOWN
 * guarantees their floors sum to at least the universe floor: both narrow suites
 * clearing their floors implies the universe would clear its own. `unit` is a
 * subset of `core` and takes its share of `core`'s slack. The loader recomputes
 * every floor and refuses a file where any differs, so a floor cannot be lowered
 * by editing one number.
 */
export interface NarrowSuiteFloors {
  /** The commit the counts were measured at. */
  readonly measuredAt: string
  /** Files the universe selected per tier at that commit. */
  readonly universeSelected: Readonly<Record<string, number>>
  readonly floors: Readonly<Record<NarrowSuiteName, Readonly<Record<string, NarrowSuiteFloor>>>>
}

export interface TierPopulationFile {
  readonly schema: "quanta.test-tier-population.v2"
  readonly tiers: Readonly<Record<string, TierPopulationFloor>>
  readonly suites: NarrowSuiteFloors
}

/** Which suites are the universe. Keyed by `SuiteName`, so a new suite is a type error until classified. */
export const SUITE_SCOPE = {
  full: "universe",
  core: "narrower-suite",
  unit: "narrower-suite",
  integration: "narrower-suite",
} as const satisfies Record<SuiteName, "universe" | "narrower-suite">

/** Each narrow suite's parent for the slack share. */
export const SUITE_PARENT = {
  core: "full",
  integration: "full",
  unit: "core",
} as const satisfies Record<NarrowSuiteName, SuiteName>

/** The narrow suites that partition the universe. */
export const UNIVERSE_PARTITION = [
  "core",
  "integration",
] as const satisfies readonly NarrowSuiteName[]

const NARROW_SUITES = Object.keys(SUITE_PARENT) as NarrowSuiteName[]

export const TIER_POPULATION_PATH = join(import.meta.dir, "test-tier-population.json")

export const deriveNarrowFloor = (input: {
  readonly selected: number
  readonly parentSelected: number
  readonly parentFloor: number
}): number =>
  input.selected -
  Math.floor(((input.parentSelected - input.parentFloor) * input.selected) / input.parentSelected)

const sameKeys = (label: string, actual: readonly string[], expected: readonly string[]): void => {
  const a = [...actual].sort().join(",")
  const e = [...expected].sort().join(",")
  if (a !== e) throw new Error(`tier population: ${label} must be exactly [${e}], got [${a}]`)
}

const assertFloorRow = (label: string, floor: TierPopulationFloor): void => {
  if (!Number.isSafeInteger(floor.minFiles) || floor.minFiles < 1) {
    throw new Error(`tier population: ${label} has a non-positive minFiles`)
  }
  if (typeof floor.reason !== "string" || floor.reason.trim() === "") {
    throw new Error(`tier population: ${label} has no reason`)
  }
}

const parentOf = (
  file: TierPopulationFile,
  suite: NarrowSuiteName,
  tier: string,
): { readonly selected: number; readonly floor: number } => {
  const parent = SUITE_PARENT[suite]
  if (parent === "full") {
    return {
      selected: file.suites.universeSelected[tier] ?? 0,
      floor: file.tiers[tier]?.minFiles ?? 0,
    }
  }
  const row = file.suites.floors[parent][tier]
  return { selected: row?.selected ?? 0, floor: row?.minFiles ?? 0 }
}

const assertNarrowTier = (file: TierPopulationFile, tier: string): void => {
  const universe = file.suites.universeSelected[tier]
  const universeFloor = file.tiers[tier]?.minFiles ?? 0
  if (universe === undefined || !Number.isSafeInteger(universe) || universe < universeFloor) {
    throw new Error(`tier population: universeSelected.${tier} is missing or below its floor`)
  }
  for (const suite of NARROW_SUITES) {
    const row = file.suites.floors[suite][tier]
    if (row === undefined)
      throw new Error(`tier population: suites.floors.${suite}.${tier} is missing`)
    assertFloorRow(`suites.floors.${suite}.${tier}`, row)
    if (!Number.isSafeInteger(row.selected) || row.selected < row.minFiles) {
      throw new Error(
        `tier population: suites.floors.${suite}.${tier}.selected is below its own floor`,
      )
    }
    const parent = parentOf(file, suite, tier)
    const derived = deriveNarrowFloor({
      selected: row.selected,
      parentSelected: parent.selected,
      parentFloor: parent.floor,
    })
    if (row.minFiles !== derived) {
      throw new Error(
        `tier population: suites.floors.${suite}.${tier}.minFiles is ${row.minFiles} but the ` +
          `share rule derives ${derived}. A narrow floor is not picked; recompute it.`,
      )
    }
  }
  const partition = UNIVERSE_PARTITION.map((suite) => file.suites.floors[suite][tier])
  const selectedSum = partition.reduce((sum, row) => sum + (row?.selected ?? 0), 0)
  if (selectedSum !== universe) {
    throw new Error(
      `tier population: ${UNIVERSE_PARTITION.join(" + ")} selected ${selectedSum} at ${tier} but the ` +
        `universe selected ${universe}. They partition it; the measurements disagree.`,
    )
  }
  // No separate "partition floors sum to at least the universe floor" check: it
  // cannot fail once the two checks above hold. Each share is rounded DOWN, so
  //   Σ minFiles = Σ selected − Σ floor(slack·selected/U) ≥ U − slack = universe floor.
  // It was here, and an audit-style neuter of the partition identity above was
  // masked by it — two checks answering one question, one of them unfailable.
  const unit = file.suites.floors.unit[tier]
  const core = file.suites.floors.core[tier]
  if (unit !== undefined && core !== undefined && unit.selected > core.selected) {
    throw new Error(
      `tier population: unit selected more than core at ${tier}, but unit is inside core`,
    )
  }
}

export const loadTierPopulationFloors = (
  path: string = TIER_POPULATION_PATH,
): TierPopulationFile => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as TierPopulationFile
  if (parsed.schema !== "quanta.test-tier-population.v2") {
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
  for (const [tier, floor] of Object.entries(tiers)) assertFloorRow(tier, floor)
  const suites = parsed.suites
  if (typeof suites !== "object" || suites === null) {
    throw new Error("tier population: `suites` is missing — every narrow suite needs its floors")
  }
  sameKeys("suites.floors", Object.keys(suites.floors ?? {}), NARROW_SUITES)
  for (const suite of NARROW_SUITES) {
    sameKeys(`suites.floors.${suite}`, Object.keys(suites.floors[suite]), Object.keys(tiers))
  }
  sameKeys(
    "suites.universeSelected",
    Object.keys(suites.universeSelected ?? {}),
    Object.keys(tiers),
  )
  for (const tier of Object.keys(tiers)) assertNarrowTier(parsed, tier)
  return parsed
}

export type TierPopulationVerdict =
  | { readonly ok: true; readonly floor: number }
  | {
      readonly ok: false
      readonly kind:
        | "no-floor"
        | "suite-corpus-lost"
        | "empty-selection"
        | "narrowed"
        | "universe-below-tier-floor"
        | "suite-below-its-tier-floor"
        | "over-selected"
      readonly message: string
    }

/** Verdict kinds that mean the CORPUS is at fault, not the selection. */
export const CORPUS_LOSS_KINDS: ReadonlySet<string> = new Set([
  "suite-corpus-lost",
  "universe-below-tier-floor",
  "suite-below-its-tier-floor",
])

const floorFor = (
  floors: TierPopulationFile,
  suite: SuiteName,
  tier: string,
): TierPopulationFloor | undefined =>
  suite === "full" ? floors.tiers[tier] : floors.suites.floors[suite][tier]

/**
 * Check a tier's SELECTED population against the floor for THIS suite.
 *
 * `suite` and `suiteFloor` are required. They were optional, and the function
 * then printed "the suite's own pre-selection floor was cleared" — a check it
 * never performed — for any caller that omitted them. It now performs it.
 */
export const checkTierPopulation = (input: {
  readonly tier: string
  readonly suite: SuiteName
  readonly selected: number
  readonly discovered: number
  readonly suiteFloor: number
  readonly floors: TierPopulationFile
}): TierPopulationVerdict => {
  const label = `suite=${input.suite} tier=${input.tier}`
  if (input.discovered < input.suiteFloor) {
    return {
      ok: false,
      kind: "suite-corpus-lost",
      message:
        `[test:shards] INVALID — ${label} discovered ${input.discovered} files, below the suite's ` +
        `pinned floor of ${input.suiteFloor}. The corpus shrank.`,
    }
  }
  const floor = floorFor(input.floors, input.suite, input.tier)
  if (floor === undefined) {
    const where = input.suite === "full" ? "tiers" : `suites.floors.${input.suite}`
    return {
      ok: false,
      kind: "no-floor",
      message:
        `[test:shards] INVALID — ${label} has no committed population floor in ` +
        `test-tier-population.json (${where}). An unlisted pair is not a default: add it, with a ` +
        "reason, in the same diff that introduced it.",
    }
  }
  if (input.selected > input.discovered) {
    return {
      ok: false,
      kind: "over-selected",
      message:
        `[test:shards] INVALID — ${label} selected ${input.selected} files from ` +
        `${input.discovered} discovered. Selection cannot exceed discovery.`,
    }
  }
  if (input.selected === 0) {
    return {
      ok: false,
      kind: "empty-selection",
      message:
        `[test:shards] INVALID — ${label} selected zero of ${input.discovered} discovered files. ` +
        "The corpus is intact; the SELECTION is empty.",
    }
  }
  if (input.selected >= floor.minFiles) return { ok: true, floor: floor.minFiles }
  if (input.selected === input.discovered) {
    return {
      ok: false,
      kind:
        SUITE_SCOPE[input.suite] === "universe"
          ? "universe-below-tier-floor"
          : "suite-below-its-tier-floor",
      message:
        `[test:shards] INVALID — ${label} selected all ${input.selected} discovered files, and that ` +
        `is still below its committed floor of ${floor.minFiles} (${floor.reason}). NOTHING was ` +
        "narrowed: the suite itself shrank past what this tier promises. The suite floor sits " +
        "lower and did not catch it — fix the corpus, or lower both floors together and say why.",
    }
  }
  return {
    ok: false,
    kind: "narrowed",
    message:
      `[test:shards] INVALID — ${label} selected ${input.selected} files, below its committed ` +
      `floor of ${floor.minFiles} (${floor.reason}). The suite discovered ${input.discovered} ` +
      "files, so this is a SELECTION shrink, not corpus loss. If the narrowing is intended, " +
      "lower the floor in the same diff and say why.",
  }
}
