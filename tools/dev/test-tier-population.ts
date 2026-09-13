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
 * When the split landed, `prepush`, `pr` and `full` resolved to one identical
 * set; they no longer do (the capability and nightly-heavy files leave `pr`),
 * which is exactly when an intentional reduction would have been reported as
 * "the corpus shrank under the runner", false and pointing at the wrong file.
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

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parsePolicyOverrides, selectIdsForTier } from "./test-policy"
import {
  isDiscoverableTestPath,
  SUITE_ROOTS,
  type SuiteName,
  suiteMembers,
} from "./test-shard-discovery"
import { assertKnownTier } from "./verification-tier"

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
 * by editing one number — and an arm recounts the whole record from
 * `measuredAt` (`measureTierPopulation`), so it cannot be lowered consistently
 * either.
 */
export interface NarrowSuiteFloors {
  /** The commit the counts were measured at. `--measure` recounts it exactly. */
  readonly measuredAt: string
  /**
   * Files each suite DISCOVERED at that commit.
   *
   * What makes a shortfall attributable. The check used to call it corpus loss
   * only when `selected === discovered`, which holds at `nightly` alone, so at
   * the other three tiers a real loss was reported as "a SELECTION shrink … lower
   * the floor" — measured by an audit deleting 60 selected unit files.
   */
  readonly discovered: Readonly<Record<SuiteName, number>>
  /** Files the universe selected per tier at that commit. */
  readonly universeSelected: Readonly<Record<string, number>>
  readonly floors: Readonly<Record<NarrowSuiteName, Readonly<Record<string, NarrowSuiteFloor>>>>
}

export interface TierPopulationFile {
  readonly schema: "quanta.test-tier-population.v3"
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

const assertDiscovered = (file: TierPopulationFile): void => {
  const discovered = file.suites.discovered
  if (typeof discovered !== "object" || discovered === null) {
    throw new Error("tier population: `suites.discovered` is missing")
  }
  sameKeys("suites.discovered", Object.keys(discovered), Object.keys(SUITE_SCOPE))
  for (const [suite, count] of Object.entries(discovered)) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(`tier population: suites.discovered.${suite} is not a positive count`)
    }
  }
  const partition = UNIVERSE_PARTITION.reduce((sum, suite) => sum + discovered[suite], 0)
  if (partition !== discovered.full) {
    throw new Error(
      `tier population: ${UNIVERSE_PARTITION.join(" + ")} discovered ${partition} but the universe ` +
        `discovered ${discovered.full}. They partition it; the measurements disagree.`,
    )
  }
  if (discovered.unit > discovered.core) {
    throw new Error("tier population: unit discovered more than core, but unit is inside core")
  }
}

const assertNarrowRow = (
  file: TierPopulationFile,
  suite: NarrowSuiteName,
  tier: string,
  row: NarrowSuiteFloor,
): void => {
  assertFloorRow(`suites.floors.${suite}.${tier}`, row)
  if (!Number.isSafeInteger(row.selected) || row.selected < row.minFiles) {
    throw new Error(
      `tier population: suites.floors.${suite}.${tier}.selected is below its own floor`,
    )
  }
  if (row.selected > file.suites.discovered[suite]) {
    throw new Error(
      `tier population: suites.floors.${suite}.${tier}.selected exceeds what ${suite} discovered`,
    )
  }
}

const assertNarrowTier = (file: TierPopulationFile, tier: string): void => {
  const universe = file.suites.universeSelected[tier]
  const universeFloor = file.tiers[tier]?.minFiles ?? 0
  if (universe === undefined || !Number.isSafeInteger(universe) || universe < universeFloor) {
    throw new Error(`tier population: universeSelected.${tier} is missing or below its floor`)
  }
  if (universe > file.suites.discovered.full) {
    throw new Error(
      `tier population: universeSelected.${tier} exceeds what the universe discovered`,
    )
  }
  for (const suite of NARROW_SUITES) {
    const row = file.suites.floors[suite][tier]
    if (row === undefined)
      throw new Error(`tier population: suites.floors.${suite}.${tier} is missing`)
    assertNarrowRow(file, suite, tier, row)
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
  if (parsed.schema !== "quanta.test-tier-population.v3") {
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
  assertDiscovered(parsed)
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
  // Attributed against the MEASUREMENT, not against `selected === discovered`.
  const suites = input.floors.suites
  const measuredDiscovered = suites.discovered[input.suite]
  const measuredSelected =
    input.suite === "full"
      ? (suites.universeSelected[input.tier] ?? 0)
      : (suites.floors[input.suite][input.tier]?.selected ?? 0)
  const lost = measuredDiscovered - input.discovered
  const excludedNow = input.discovered - input.selected
  const excludedThen = measuredDiscovered - measuredSelected
  const facts =
    `The suite discovers ${input.discovered} files and selection excludes ${excludedNow}; at ` +
    `${suites.measuredAt} it discovered ${measuredDiscovered} and excluded ${excludedThen}.`
  const remeasure = "`bun run tools/dev/test-tier-population.ts --measure`"
  if (lost > 0) {
    return {
      ok: false,
      kind:
        SUITE_SCOPE[input.suite] === "universe"
          ? "universe-below-tier-floor"
          : "suite-below-its-tier-floor",
      message:
        `[test:shards] INVALID — ${label} selected ${input.selected} files, below its committed ` +
        `floor of ${floor.minFiles} (${floor.reason}). ${facts} ${lost} file(s) left the CORPUS — ` +
        `restore them. If removing them was intended, re-measure with ${remeasure} in the same diff.`,
    }
  }
  return {
    ok: false,
    kind: "narrowed",
    message:
      `[test:shards] INVALID — ${label} selected ${input.selected} files, below its committed ` +
      `floor of ${floor.minFiles} (${floor.reason}). ${facts} The corpus did not shrink; selection ` +
      `excludes ${excludedNow - excludedThen} more file(s). If the narrowing is intended, re-measure ` +
      `with ${remeasure} in the same diff and say why.`,
  }
}

const gitText = (repoRoot: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}

const NARROW_ORDER: readonly NarrowSuiteName[] = ["core", "integration", "unit"]

/**
 * The record, recounted from a COMMIT: its tree, its override file, and this
 * checkout's classification code.
 *
 * # Why the record must be a recount
 *
 * The loader checks the record is internally consistent, and an audit showed
 * consistency is not honesty: `unit` sits outside the partition identity, so
 * setting `unit.*.selected = 1` and re-deriving loaded clean with every unit
 * floor at 1; lowering `universeSelected` together with `integration` did the
 * same for integration. `measuredAt` was a label. Recounted, it is the
 * authority: an arm compares this to the committed record, so a hand-edited
 * count fails, and a record that no longer matches the classification code
 * fails until someone re-measures.
 *
 * `tiers` (the universe floors, with reasons) are the one picked input. They are
 * carried from the caller, and every narrow floor derives from them.
 */
export const measureTierPopulation = (input: {
  readonly repoRoot: string
  readonly rev: string
  readonly tiers: TierPopulationFile["tiers"]
}): TierPopulationFile => {
  const sha = gitText(input.repoRoot, ["rev-parse", "--short=9", `${input.rev}^{commit}`]).trim()
  const universe = gitText(input.repoRoot, ["ls-tree", "-r", "-z", "--name-only", sha])
    .split("\0")
    .filter(isDiscoverableTestPath)
  const overrides = parsePolicyOverrides(
    gitText(input.repoRoot, ["show", `${sha}:tools/dev/test-policy-overrides.json`]),
  ).overrides
  const discovered = Object.fromEntries(
    (Object.keys(SUITE_ROOTS) as SuiteName[]).map((suite) => [
      suite,
      suiteMembers(universe, suite),
    ]),
  ) as Record<SuiteName, readonly string[]>
  const tierNames = Object.keys(input.tiers)
  const selectedCount = (suite: SuiteName, tier: string): number =>
    selectIdsForTier(discovered[suite], assertKnownTier(tier), overrides).length
  const universeSelected = Object.fromEntries(
    tierNames.map((tier) => [tier, selectedCount("full", tier)]),
  )
  const floors = { core: {}, integration: {}, unit: {} } as Record<
    NarrowSuiteName,
    Record<string, NarrowSuiteFloor>
  >
  for (const suite of NARROW_ORDER) {
    const parent = SUITE_PARENT[suite]
    for (const tier of tierNames) {
      const selected = selectedCount(suite, tier)
      const parentSelected =
        parent === "full" ? (universeSelected[tier] ?? 0) : (floors[parent][tier]?.selected ?? 0)
      const parentFloor =
        parent === "full"
          ? (input.tiers[tier]?.minFiles ?? 0)
          : (floors[parent][tier]?.minFiles ?? 0)
      const minFiles = deriveNarrowFloor({ selected, parentSelected, parentFloor })
      floors[suite][tier] = {
        selected,
        minFiles,
        reason:
          `measured ${selected} of ${discovered[suite].length} discovered at ${sha}; share ` +
          `floor((${parentSelected}-${parentFloor})*${selected}/${parentSelected})=` +
          `${selected - minFiles} of ${parent}'s slack`,
      }
    }
  }
  return {
    schema: "quanta.test-tier-population.v3",
    tiers: input.tiers,
    suites: {
      measuredAt: sha,
      discovered: Object.fromEntries(
        Object.entries(discovered).map(([suite, files]) => [suite, files.length]),
      ) as Record<SuiteName, number>,
      universeSelected,
      floors,
    },
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const measure = argv.find((arg) => arg === "--measure" || arg.startsWith("--measure="))
  if (measure === undefined) {
    process.stderr.write("usage: test-tier-population.ts --measure[=<rev>]  (default HEAD)\n")
    process.exit(2)
  }
  const rev = measure.includes("=") ? measure.slice("--measure=".length) : "HEAD"
  // Only `tiers` is read from the current file, and it is read raw: re-measuring
  // must work on a record the loader would refuse, which is when it is needed.
  const current = JSON.parse(readFileSync(TIER_POPULATION_PATH, "utf8")) as TierPopulationFile
  const record = measureTierPopulation({
    repoRoot: resolve(import.meta.dir, "..", ".."),
    rev,
    tiers: current.tiers,
  })
  writeFileSync(TIER_POPULATION_PATH, `${JSON.stringify(record, null, 2)}\n`)
  loadTierPopulationFloors()
  process.stdout.write(
    `tier population measured at ${record.suites.measuredAt}: ` +
      `${JSON.stringify(record.suites.discovered)} -> ${TIER_POPULATION_PATH}\n`,
  )
}
