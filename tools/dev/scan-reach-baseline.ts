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

/**
 * Everything the CLI decides once the child has run — pure, so a failing child is
 * testable without a fixture that pollutes the tree.
 *
 * `childExit` is the reason this exists. It used to be PRINTED in the summary
 * line and checked nowhere, so `bun run scan-reach` could exit 0 while the guards
 * it ran were failing: the reach numbers are recorded before an assertion fails,
 * so a red suite still produces a full harvest. A gate whose evidence is "the
 * numbers matched" while the tests it measured were failing is the same defect
 * this whole file exists to close, one level up.
 */
export interface ReachRun {
  readonly childExit: number
  readonly observed: ReadonlyMap<string, ScanReach>
  readonly baseline: ScanReachBaseline
  readonly tighten: boolean
  /**
   * Per FILE, the baseline ids that file must report — the site-level
   * completeness claim, checked against ground truth.
   *
   * A file can hold several scans, and enrolling one of them used to be enough
   * to call the file done. Counting syntax cannot settle it: a recursive walker's
   * internal `readdirSync` is one site, not one per level, and a helper called in
   * a loop reports THREE ids from one call (`no-leftover-backup-files`). What the
   * guards actually REPORT is the only reading that is neither over- nor
   * under-counting, and this is the run that has it.
   */
  readonly expectedIds?: Readonly<Record<string, readonly string[]>>
}

export interface ReachDecision {
  readonly exit: 0 | 1
  readonly lines: readonly string[]
  /** Only ever true when nothing else is wrong. */
  readonly doTighten: boolean
}

export const decide = (run: ReachRun): ReachDecision => {
  const lines: string[] = []
  if (run.observed.size === 0) {
    return {
      exit: 1,
      doTighten: false,
      lines: [
        "scan-reach: the guards recorded NO reach at all — the run is the measurement, " +
          "so a silent zero here would pin every floor at nothing.",
      ],
    }
  }
  const { regressions, unpinned, drops, stale } = verdictFor(run.observed, run.baseline)
  const missingIds = Object.entries(run.expectedIds ?? {}).flatMap(([file, ids]) =>
    ids
      .filter((id) => !run.observed.has(id))
      .map(
        (id) =>
          `${file} is recorded as enrolled for "${id}", but no guard reported it — the scan ` +
          "was renamed, removed, or never ran",
      ),
  )
  const blocking = [
    ...(run.childExit === 0
      ? []
      : [
          `the guards themselves FAILED (bun test exit ${run.childExit}) — reach is recorded ` +
            "before an assertion fails, so a full harvest is not evidence that anything passed",
        ]),
    ...regressions,
    ...unpinned,
    ...stale,
    ...missingIds,
  ]
  if (blocking.length > 0) {
    lines.push("scan-reach: refusing.")
    lines.push("A shrunken scan is fixed at the scan, never by lowering the number.")
    for (const b of blocking) lines.push(`  ${b}`)
    // Tightening over ANY of these blesses a number nobody reviewed: over a
    // failing child it pins whatever a red run happened to reach, and over an
    // unpinned or stale row it adds or keeps a pin the closed universe refused.
    return { exit: 1, doTighten: false, lines }
  }
  if (run.tighten) {
    return {
      exit: 0,
      doTighten: true,
      lines: [`scan-reach: tightened ${run.observed.size} scans (${drops.length} had grown)`],
    }
  }
  for (const d of drops)
    lines.push(`scan-reach: ${d} — \`bun run scan-reach --tighten\` locks it in`)
  lines.push(`scan-reach: ${run.observed.size} scans at or above their floors`)
  return { exit: 0, doTighten: false, lines }
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
  const child = Bun.spawnSync(["bun", "test", ...files], {
    env: { ...process.env, QUANTA_SCAN_REACH_RECORD: sink },
    stdout: "pipe",
    stderr: "pipe",
  })
  const observed = harvest(sink)
  const baseline = readScanReachBaseline()
  const debt = JSON.parse(
    readFileSync(join(import.meta.dir, "scan-enrollment-debt.json"), "utf8"),
  ) as { expectedIds?: Readonly<Record<string, readonly string[]>> }
  const verdict = decide({
    childExit: child.exitCode,
    observed,
    baseline,
    tighten: process.argv.includes("--tighten"),
    ...(debt.expectedIds === undefined ? {} : { expectedIds: debt.expectedIds }),
  })
  for (const line of verdict.lines) {
    // biome-ignore lint/suspicious/noConsole: the CLI reports to the operator
    console.error(line)
  }
  if (verdict.exit !== 0 && child.exitCode !== 0) {
    // The child's own output is the actionable part when the guards failed.
    // biome-ignore lint/suspicious/noConsole: the CLI reports to the operator
    console.error(`${child.stdout.toString()}${child.stderr.toString()}`.slice(-4000))
  }
  if (verdict.doTighten) tighten(observed, baseline)
  process.exit(verdict.exit)
}
