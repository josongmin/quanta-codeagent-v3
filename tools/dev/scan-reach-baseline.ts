/**
 * Committed, ratcheted REACH numbers for the repo's scanning guards.
 *
 * WHY A FILE AND NOT A PARAMETER. A floor written at the call site is a number
 * the author picked, and the observed equilibrium for such a parameter in this
 * repo is `1`: of the 81 floors already written, 56 are `toBeGreaterThan(0)`,
 * which passes against any non-empty directory and says nothing about a partial
 * walk, a wrong subtree, or a matcher that stopped matching. The number has to
 * come from MEASUREMENT and be committed where a diff can see it move — the
 * shape `lint-debt-ceiling.json`, `god-code/allowlist.json` and
 * `unit-speed-budget.json` already use here.
 *
 * DIRECTION. These are FLOORS, so the ratchet runs the other way from a debt
 * ceiling: `--tighten` RAISES them to the measured reach, and nothing lowers
 * them without an explicit edit a reviewer can see.
 *
 *   reach <  floor  → REGRESSION. The scan shrank; the verdicts under it are
 *                     worthless until it is explained.
 *   reach >  floor  → advisory. `bun run scan-reach --tighten` locks it in.
 *   scan not pinned → FAILURE, not a default. A closed universe is the only
 *                     thing that stops a new guard shipping with no reach at
 *                     all, which is the defect this whole file exists for.
 *
 * TWO NUMBERS. `walked` proves the anchor: the scan reached a real corpus.
 * `matched` proves the predicate: the guard's own matcher still selects
 * something. A matcher that rotted after a refactor selects nothing while the
 * walk stays full, so a floor on `walked` alone clears it.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface ScanReach {
  readonly walked: number
  readonly matched?: number
}

export interface ScanReachBaseline {
  readonly note: string
  readonly scans: Readonly<Record<string, ScanReach>>
}

export const BASELINE_PATH = join(import.meta.dir, "scan-reach-baseline.json")

export const readScanReachBaseline = (path: string = BASELINE_PATH): ScanReachBaseline =>
  JSON.parse(readFileSync(path, "utf8")) as ScanReachBaseline

export interface ReachVerdict {
  /** The scan shrank below its committed floor. */
  readonly regressions: readonly string[]
  /** A scan reported reach with no pinned floor — the closed universe is open. */
  readonly unpinned: readonly string[]
  /** The scan grew; a `--tighten` can lock it in. */
  readonly drops: readonly string[]
}

/** Observations are `id → measured reach`, produced by running the guards. */
export const verdictFor = (
  observed: ReadonlyMap<string, ScanReach>,
  baseline: ScanReachBaseline,
): ReachVerdict => {
  const regressions: string[] = []
  const unpinned: string[] = []
  const drops: string[] = []
  for (const [id, seen] of observed) {
    const pinned = baseline.scans[id]
    if (pinned === undefined) {
      unpinned.push(`${id}: reach ${seen.walked} observed with no pinned floor`)
      continue
    }
    if (seen.walked < pinned.walked) {
      regressions.push(`${id}: walked ${seen.walked} < floor ${pinned.walked}`)
    } else if (seen.walked > pinned.walked) {
      drops.push(`${id}: walked ${seen.walked} > floor ${pinned.walked}`)
    }
    if (pinned.matched !== undefined) {
      const m = seen.matched
      if (m === undefined) {
        regressions.push(`${id}: a matched floor is pinned but the guard reported none`)
      } else if (m < pinned.matched) {
        regressions.push(`${id}: matched ${m} < floor ${pinned.matched}`)
      } else if (m > pinned.matched) {
        drops.push(`${id}: matched ${m} > floor ${pinned.matched}`)
      }
    }
  }
  return { regressions, unpinned, drops }
}

/** Rewrite the baseline at the measured reach. Refuses while anything is BELOW
 *  its floor: tightening past a regression would erase the regression. */
export const tighten = (
  observed: ReadonlyMap<string, ScanReach>,
  baseline: ScanReachBaseline,
  path: string = BASELINE_PATH,
): void => {
  const { regressions } = verdictFor(observed, baseline)
  if (regressions.length > 0) {
    throw new Error(
      `scan-reach: refusing to --tighten while a scan is BELOW its floor (floors only go UP):\n  ${regressions.join("\n  ")}`,
    )
  }
  const scans: Record<string, ScanReach> = { ...baseline.scans }
  for (const [id, seen] of observed) {
    scans[id] = seen.matched === undefined ? { walked: seen.walked } : { walked: seen.walked, matched: seen.matched }
  }
  const sorted = Object.fromEntries(Object.entries(scans).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(path, `${JSON.stringify({ note: baseline.note, scans: sorted }, null, 2)}\n`)
}
