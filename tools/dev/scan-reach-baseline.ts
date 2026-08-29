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
  /**
   * A row nobody reported. Either the guard was deleted and the row is dead
   * weight, or — the case that matters — the guard stopped running and its
   * floor now defends nothing while still reading as coverage.
   */
  readonly stale: readonly string[]
}

/** One scan's `walked` number against its pin. */
const walkedVerdict = (id: string, seen: ScanReach, pinned: ScanReach): [string, string] | null => {
  if (seen.walked < pinned.walked)
    return ["reg", `${id}: walked ${seen.walked} < floor ${pinned.walked}`]
  if (seen.walked > pinned.walked)
    return ["drop", `${id}: walked ${seen.walked} > floor ${pinned.walked}`]
  return null
}

/** One scan's `matched` number against its pin. Absent on both sides is fine;
 *  present on exactly one is a contradiction the guard has to resolve. */
const matchedVerdict = (
  id: string,
  seen: ScanReach,
  pinned: ScanReach,
): [string, string] | null => {
  if (pinned.matched === undefined) return null
  if (seen.matched === undefined) {
    return ["reg", `${id}: a matched floor is pinned but the guard reported none`]
  }
  if (seen.matched < pinned.matched)
    return ["reg", `${id}: matched ${seen.matched} < floor ${pinned.matched}`]
  if (seen.matched > pinned.matched)
    return ["drop", `${id}: matched ${seen.matched} > floor ${pinned.matched}`]
  return null
}

/** Observations are `id → measured reach`, produced by running the guards. */
export const verdictFor = (
  observed: ReadonlyMap<string, ScanReach>,
  baseline: ScanReachBaseline,
): ReachVerdict => {
  const bucket: Record<string, string[]> = { reg: [], drop: [] }
  const unpinned: string[] = []
  for (const [id, seen] of observed) {
    const pinned = baseline.scans[id]
    if (pinned === undefined) {
      unpinned.push(`${id}: reach ${seen.walked} observed with no pinned floor`)
      continue
    }
    for (const v of [walkedVerdict(id, seen, pinned), matchedVerdict(id, seen, pinned)]) {
      if (v !== null) bucket[v[0]]?.push(v[1])
    }
  }
  const stale = Object.keys(baseline.scans)
    .filter((id) => !observed.has(id))
    .map((id) => `${id}: pinned but no guard reported it`)
  return { regressions: bucket.reg ?? [], unpinned, drops: bucket.drop ?? [], stale }
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
  // Rewrites only rows that ALREADY exist, the shape `lint-debt --tighten` uses:
  // a tightener that can add pins is a tightener that can bless a brand-new scan
  // nobody reviewed, which is the hole the closed universe exists to close.
  const scans: Record<string, ScanReach> = { ...baseline.scans }
  for (const [id, seen] of observed) {
    if (scans[id] === undefined) continue
    scans[id] =
      seen.matched === undefined
        ? { walked: seen.walked }
        : { walked: seen.walked, matched: seen.matched }
  }
  const sorted = Object.fromEntries(Object.entries(scans).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(path, `${JSON.stringify({ note: baseline.note, scans: sorted }, null, 2)}\n`)
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//
// `bun run scan-reach [--tighten]` runs the guards with recording on, harvests
// what each scan actually reached, and reports the verdict. Recording is opt-in
// via `QUANTA_SCAN_REACH_RECORD` so a normal test run neither writes nor depends
// on it.

/** A scan seen more than once takes its SMALLEST reach: the floor has to hold on
 *  the run that saw least, not on the luckiest one. */
const mergeReach = (
  prev: ScanReach | undefined,
  seen: { readonly walked: number; readonly matched?: number },
): ScanReach => {
  const walked = prev === undefined ? seen.walked : Math.min(prev.walked, seen.walked)
  const both = [prev?.matched, seen.matched].filter((m): m is number => m !== undefined)
  return both.length === 0 ? { walked } : { walked, matched: Math.min(...both) }
}

const harvest = (sink: string): Map<string, ScanReach> => {
  const observed = new Map<string, ScanReach>()
  for (const line of readFileSync(sink, "utf8").split("\n")) {
    if (line === "") continue
    const r = JSON.parse(line) as { id: string; walked: number; matched?: number }
    const prev = observed.get(r.id)
    observed.set(r.id, mergeReach(prev, r))
  }
  return observed
}

if (import.meta.main) {
  const sink = `${process.env.TMPDIR ?? "/tmp"}/quanta-scan-reach-${process.pid}.jsonl`
  writeFileSync(sink, "")
  // The guards that CALL the helper, plus the tests that reach it through a
  // shared suite. `slice-boundary-scanner.ts` is not a test file and its 49
  // entrypoints never name the helper, so a list built from the direct string
  // alone leaves 49 pinned rows reporting nothing — which the STALE check then
  // fails on, correctly and unhelpfully.
  const grep = (pattern: string): readonly string[] =>
    new TextDecoder()
      .decode(
        Bun.spawnSync(["git", "grep", "-l", pattern, "--", "tests", "src"], { stdout: "pipe" })
          .stdout,
      )
      .split("\n")
      .filter((f) => f !== "")
  const direct = grep("assertScanPopulation")
  const indirect = direct
    .filter((f) => !f.endsWith(".test.ts"))
    .flatMap((mod) => grep(`from "[^"]*${mod.replace(/^.*\//, "").replace(/\.ts$/, "")}"`))
  const files = [...new Set([...direct, ...indirect])].filter(
    (f) =>
      f.endsWith(".test.ts") &&
      !f.includes("_shared/scan-population") &&
      !f.includes("floor-hellgate"),
  )
  const run = Bun.spawnSync(["bun", "test", ...files], {
    env: { ...process.env, QUANTA_SCAN_REACH_RECORD: sink },
    stdout: "pipe",
    stderr: "pipe",
  })
  const observed = harvest(sink)
  if (observed.size === 0) {
    // biome-ignore lint/suspicious/noConsole: the CLI reports to the operator
    console.error(
      "scan-reach: the guards recorded NO reach at all — the run is the measurement, " +
        "so a silent zero here would pin every floor at nothing.",
    )
    process.exit(1)
  }
  const baseline = readScanReachBaseline()
  const { regressions, unpinned, drops, stale } = verdictFor(observed, baseline)
  const say = (line: string): void => {
    // biome-ignore lint/suspicious/noConsole: the CLI reports to the operator
    console.error(line)
  }
  if (process.argv.includes("--tighten")) {
    tighten(observed, baseline)
    say(`scan-reach: tightened ${observed.size} scans (${drops.length} had grown)`)
    process.exit(0)
  }
  if (regressions.length > 0 || unpinned.length > 0 || stale.length > 0) {
    say("scan-reach: the committed reach and the measured reach disagree.")
    say("A shrunken scan is fixed at the scan, never by lowering the number.")
    for (const r of [...regressions, ...unpinned, ...stale]) say(`  ${r}`)
    process.exit(1)
  }
  for (const d of drops) say(`scan-reach: ${d} — \`bun run scan-reach --tighten\` locks it in`)
  say(`scan-reach: ${observed.size} scans at or above their floors (test run exit ${run.exitCode})`)
}
