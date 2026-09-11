#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: CLI tool — console is the IO surface.
/**
 * `tools/dev/test-determinism-ratchet` — one-directional guard on the three
 * determinism regressions TVH-15 names (items 1-3).
 *
 * | signal | what a NEW one is | why it is blocked |
 * |---|---|---|
 * | upper-bound wall assertion in an ordinary functional test | a site whose content key is not in `test-wall-clock-inventory.json` | host load, not the unit, decides the verdict; the false RED then amplifies into a whole re-run |
 * | `Math.random()` in test source | a call beyond the per-file, per-role baseline | the failing case/order/delay cannot be replayed |
 * | awaited fixed sleep | a per-file (or corpus) millisecond total above baseline | a fixed wait is a guess about someone else's scheduler, and it is paid on every green run |
 *
 * # Why this is not a grep
 *
 * All three predicates are positional: see `test-determinism-scan.ts`. This
 * module only compares the scan against the committed ledgers.
 *
 * # The two directions this deliberately does NOT block
 *
 *   - `tests/measurement/**` may add wall assertions freely. That tier is what
 *     the inventory's `performance-contract` rows are supposed to migrate INTO,
 *     so a ratchet that blocked them would block the fix.
 *   - A site DISAPPEARING is never a failure. Deleting the assertion, or the
 *     test, is the direction this ratchet wants; the stale ledger row is
 *     reported so `--write` on the inventory can drop it.
 *
 * # Anti-vacuum floor
 *
 * A scanner that silently returns nothing would report a perfect green. Every
 * run therefore asserts it saw at least the measured number of files, wall
 * sites, random sites and sleeping files before it is allowed to pass.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type FileScan, type RandomRole, scanTestSource } from "./test-determinism-scan"
import {
  isMeasurementTier,
  listTestSources,
  listTestSourcesUnder,
  REPO_ROOT,
} from "./test-source-corpus"
import { keyedWallSites, loadWallInventory, type WallInventory } from "./test-wall-clock-inventory"

export const BASELINE_PATH = join(REPO_ROOT, "tools", "dev", "test-determinism-baseline.json")

export interface DeterminismBaseline {
  readonly schema: "quanta.test-determinism-baseline.v1"
  readonly floors: {
    readonly minFilesScanned: number
    readonly minWallSites: number
    readonly minRandomSites: number
    readonly minSleepFiles: number
  }
  readonly randomTotal: number
  readonly randomByFile: Readonly<Record<string, Readonly<Record<string, number | string>>>>
  readonly sleepTotalMs: number
  readonly sleepMsByFile: Readonly<Record<string, number>>
}

export type ViolationKind =
  | "new-wall-assertion"
  | "new-unseeded-random"
  | "sleep-budget-increase"
  | "anti-vacuum-floor"

export interface Violation {
  readonly kind: ViolationKind
  /** `file:line` where a site has one; the file, or `<corpus>`, otherwise. */
  readonly at: string
  readonly detail: string
}

export interface RatchetStats {
  readonly filesScanned: number
  readonly wallSites: number
  readonly randomSites: number
  readonly sleepFiles: number
  /** Every tier, for context. */
  readonly sleepTotalMs: number
  /**
   * The ORDINARY tier only — the number the budget is actually compared against.
   *
   * Printed beside the all-tier figure because they legitimately differ: a
   * nightly real-time canary is the intended DESTINATION for a wait that cannot
   * be replaced by a readiness predicate, so it counts toward what the suite
   * costs but not toward what the ordinary budget allows. Showing one number
   * would make the baseline look wrong by exactly the size of that canary.
   */
  readonly budgetedSleepTotalMs: number
}

export interface RatchetResult {
  readonly violations: readonly Violation[]
  readonly stats: RatchetStats
  /** Ledger rows whose site no longer exists. Reported, never fatal. */
  readonly staleInventoryKeys: readonly string[]
}

export const loadDeterminismBaseline = (path: string = BASELINE_PATH): DeterminismBaseline =>
  JSON.parse(readFileSync(path, "utf8")) as DeterminismBaseline

const roleCount = (
  row: Readonly<Record<string, number | string>> | undefined,
  role: RandomRole,
): number => {
  const value = row?.[role]
  return typeof value === "number" ? value : 0
}

const checkWall = (
  scans: readonly FileScan[],
  inventory: WallInventory,
): { readonly violations: readonly Violation[]; readonly stale: readonly string[] } => {
  const known = new Set(inventory.rows.map((row) => row.key))
  const seen = new Set<string>()
  const violations: Violation[] = []
  for (const site of keyedWallSites(scans)) {
    seen.add(site.key)
    if (known.has(site.key)) continue
    // The measurement tier is where throughput judgments are SUPPOSED to live.
    if (isMeasurementTier(site.file)) continue
    violations.push({
      kind: "new-wall-assertion",
      at: `${site.file}:${site.line}`,
      detail:
        `new upper-bound wall assertion \`${site.subject} ${site.matcher} ${site.bound}\` ` +
        `(${site.evidence}) is not in the inventory. Either assert the CONTRACT ` +
        `(injected clock, deferred signal, call count) or, if it is a throughput ` +
        `contract, move it to tests/measurement/ — then classify it in ` +
        "tools/dev/test-wall-clock-inventory.json.",
    })
  }
  return { violations, stale: inventory.rows.map((r) => r.key).filter((key) => !seen.has(key)) }
}

const ROLES: readonly RandomRole[] = ["outcome-relevant", "id-shaped", "unreachable-guard"]

const checkRandom = (
  scans: readonly FileScan[],
  baseline: DeterminismBaseline,
): readonly Violation[] => {
  const violations: Violation[] = []
  let total = 0
  for (const scan of scans) {
    total += scan.random.length
    if (scan.random.length === 0) continue
    const allowed = baseline.randomByFile[scan.file]
    for (const role of ROLES) {
      const found = scan.random.filter((site) => site.role === role)
      const budget = roleCount(allowed, role)
      if (found.length <= budget) continue
      const site = found[budget]
      violations.push({
        kind: "new-unseeded-random",
        at: site === undefined ? scan.file : `${scan.file}:${site.line}`,
        detail:
          `unseeded Math.random() (${role}) — ${found.length} in this file, baseline ${budget}. ` +
          "Use a seeded PRNG whose seed is printed and recorded in the failure receipt " +
          "(tools/test-resilience/failure-artifact.ts carries a `seed` field for exactly this).",
      })
    }
  }
  if (total > baseline.randomTotal) {
    violations.push({
      kind: "new-unseeded-random",
      at: "<corpus>",
      detail: `corpus Math.random() count ${total} exceeds baseline ${baseline.randomTotal}`,
    })
  }
  return violations
}

/** The `*.nightly.test.ts` / `*.nightly-*.test.ts` convention the corpus already uses. */
const NIGHTLY_FILE = /\.nightly(?:\.|-)/u

const checkSleep = (
  scans: readonly FileScan[],
  baseline: DeterminismBaseline,
): readonly Violation[] => {
  const violations: Violation[] = []
  let total = 0
  for (const scan of scans) {
    // NIGHTLY-ONLY files are outside this budget, and that is the point of the
    // budget rather than an exception to it.
    //
    // A real-time canary that cannot be replaced by a readiness predicate is
    // supposed to END UP in a `*.nightly.test.ts` sibling — that is the fix, not
    // the regression. Charging the destination against the same ceiling scores a
    // successful MOVE as growth: the 16-second quiet-window wait left the PTY
    // PR lane (that file went 22,650ms -> 6,600ms, ordinary corpus 34,530ms ->
    // 18,530ms) and landed here, and this loop called the arrival a violation.
    //
    // The ordinary tier keeps a stricter, per-file instrument in
    // `tools/dev/awaited-sleep-budget.ts`, which also forbids any single
    // ordinary wait of 15s or more. One authority per tier, not two disagreeing
    // about the same file.
    if (NIGHTLY_FILE.test(scan.file)) continue
    total += scan.sleepTotalMs
    if (scan.sleepTotalMs === 0) continue
    const budget = baseline.sleepMsByFile[scan.file] ?? 0
    if (scan.sleepTotalMs <= budget) continue
    violations.push({
      kind: "sleep-budget-increase",
      at: scan.file,
      detail:
        `awaited fixed-sleep total ${scan.sleepTotalMs}ms exceeds baseline ${budget}ms ` +
        `(${scan.sleep.map((s) => `${s.callee}(${s.ms})@${s.line}`).join(", ")}). ` +
        "Wait on the event/barrier/readiness predicate instead, or advance a virtual clock.",
    })
  }
  if (total > baseline.sleepTotalMs) {
    violations.push({
      kind: "sleep-budget-increase",
      at: "<corpus>",
      detail: `corpus awaited fixed sleep ${total}ms exceeds baseline ${baseline.sleepTotalMs}ms`,
    })
  }
  return violations
}

const checkFloors = (stats: RatchetStats, baseline: DeterminismBaseline): readonly Violation[] => {
  const floors: readonly (readonly [string, number, number])[] = [
    ["filesScanned", stats.filesScanned, baseline.floors.minFilesScanned],
    ["wallSites", stats.wallSites, baseline.floors.minWallSites],
    ["randomSites", stats.randomSites, baseline.floors.minRandomSites],
    ["sleepFiles", stats.sleepFiles, baseline.floors.minSleepFiles],
  ]
  return floors
    .filter(([, found, floor]) => found < floor)
    .map(([name, found, floor]) => ({
      kind: "anti-vacuum-floor" as const,
      at: "<corpus>",
      detail: `${name}=${found} is below the anti-vacuum floor ${floor} — the scan saw too little to be trusted`,
    }))
}

export const evaluateDeterminismRatchet = (
  scans: readonly FileScan[],
  inventory: WallInventory,
  baseline: DeterminismBaseline,
  options: { readonly skipFloors?: boolean } = {},
): RatchetResult => {
  const stats: RatchetStats = {
    filesScanned: scans.length,
    wallSites: scans.reduce((sum, scan) => sum + scan.wall.length, 0),
    randomSites: scans.reduce((sum, scan) => sum + scan.random.length, 0),
    sleepFiles: scans.filter((scan) => scan.sleepTotalMs > 0).length,
    sleepTotalMs: scans.reduce((sum, scan) => sum + scan.sleepTotalMs, 0),
    budgetedSleepTotalMs: scans
      .filter((scan) => !NIGHTLY_FILE.test(scan.file))
      .reduce((sum, scan) => sum + scan.sleepTotalMs, 0),
  }
  const wall = checkWall(scans, inventory)
  return {
    violations: [
      ...(options.skipFloors === true ? [] : checkFloors(stats, baseline)),
      ...wall.violations,
      ...checkRandom(scans, baseline),
      ...checkSleep(scans, baseline),
    ],
    stats,
    staleInventoryKeys: wall.stale,
  }
}

const main = async (): Promise<number> => {
  const rootIndex = process.argv.indexOf("--root")
  const root = rootIndex === -1 ? undefined : process.argv[rootIndex + 1]
  const files = root === undefined ? listTestSources() : listTestSourcesUnder(root)
  const scans = files.map((file) => scanTestSource(file.rel, file.text))
  const result = evaluateDeterminismRatchet(scans, loadWallInventory(), loadDeterminismBaseline(), {
    skipFloors: root !== undefined,
  })
  console.log(
    `[determinism] files=${result.stats.filesScanned} wall=${result.stats.wallSites} ` +
      `random=${result.stats.randomSites} sleep_files=${result.stats.sleepFiles} ` +
      `sleep_total_ms=${result.stats.sleepTotalMs} ` +
      `sleep_budgeted_ms=${result.stats.budgetedSleepTotalMs} ` +
      `stale_inventory_rows=${result.staleInventoryKeys.length}`,
  )
  for (const violation of result.violations) {
    console.error(`[determinism] ✗ ${violation.kind} ${violation.at}\n    ${violation.detail}`)
  }
  if (result.violations.length > 0) {
    console.error(`[determinism] ✗ ${result.violations.length} violation(s)`)
    return 1
  }
  console.log("[determinism] ✓ no new wall assertions, unseeded randomness or fixed-sleep growth")
  return 0
}

if (import.meta.main) process.exit(await main())
