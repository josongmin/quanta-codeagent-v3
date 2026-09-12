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
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { runBoundedCapture } from "./bounded-child"
import {
  type ScanReachAuthority,
  scanReachAuthorityFor,
  scanReachAuthorityProblem,
  UNTIERED_SCAN_POPULATION,
} from "./scan-reach-authority"
import { discoverSuitePopulation } from "./test-shard-discovery"

export interface ScanReach {
  readonly walked: number
  readonly matched?: number
}

export interface ScanReachBaseline {
  readonly note: string
  readonly scans: Readonly<Record<string, ScanReach>>
}

export interface ScanReachReceiptRecord extends ScanReach {
  readonly id: string
}

/**
 * Exact-checkout receipt emitted by the authoritative shard runner.
 *
 * A receipt is only a replacement for the dedicated scan-reach child when the
 * complete shard suite passed against one clean, unchanged HEAD. The consumer
 * therefore binds it to the current Git snapshot instead of treating `.cache`
 * as trusted state.
 */
export interface ScanReachReceipt extends ScanReachAuthority {
  readonly schema: "quanta.scan-reach-receipt.v2"
  readonly head: string
  readonly manifestSha256: string
  readonly childExit: 0
  readonly records: readonly ScanReachReceiptRecord[]
}

export interface ReceiptSnapshot {
  readonly head: string
  readonly status: string
}

/**
 * Why this takes the current authority instead of trusting the receipt.
 *
 * The predecessor validated `manifestSha256.length !== 64` — a LENGTH, so any
 * 64 hex characters passed and the digest named nothing. `suite` sat in the
 * type and was never compared, so a `unit` receipt (a strict subset of the
 * enrolled ids) stood in for the full universe. There was no `tier` at all, so
 * `--suite=full --tier=pr` — 3,941 of 3,965 files at this HEAD — minted a receipt the
 * closed-universe consumer accepted.
 *
 * That matters here specifically because scan-reach is a FLOOR: a receipt from
 * a narrower population carries lower reach for ids it never walked, and this
 * consumer either reports that as a regression in the wrong place or accepts it
 * and lets a guard ship with a reach nobody measured.
 */
export const observedFromReceipt = (
  receipt: ScanReachReceipt,
  snapshot: ReceiptSnapshot,
  current: ScanReachAuthority,
): ReadonlyMap<string, ScanReach> | undefined => {
  if (
    receipt.schema !== "quanta.scan-reach-receipt.v2" ||
    receipt.childExit !== 0 ||
    receipt.head !== snapshot.head ||
    snapshot.status !== "" ||
    !/^[0-9a-f]{64}$/.test(receipt.manifestSha256) ||
    receipt.records.length === 0
  ) {
    return undefined
  }
  if (scanReachAuthorityProblem(receipt, current) !== undefined) return undefined
  const observed = new Map<string, ScanReach>()
  for (const { id, walked, matched } of receipt.records) {
    if (id === "" || !Number.isSafeInteger(walked) || walked < 0) return undefined
    if (matched !== undefined && (!Number.isSafeInteger(matched) || matched < 0)) return undefined
    observed.set(
      id,
      mergeReach(observed.get(id), { walked, ...(matched === undefined ? {} : { matched }) }),
    )
  }
  return observed
}

export const BASELINE_PATH = join(import.meta.dir, "scan-reach-baseline.json")
export const SHARD_RECEIPT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  ".cache",
  "scan-reach-receipt.json",
)

interface BaselineSnapshot {
  readonly identity: string
  readonly baseline: ScanReachBaseline
}

const baselineSnapshots = new Map<string, BaselineSnapshot>()

const baselineIdentity = (path: string): string => {
  const info = statSync(path, { bigint: true })
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":")
}

const freezeBaseline = (baseline: ScanReachBaseline): ScanReachBaseline => {
  for (const reach of Object.values(baseline.scans)) Object.freeze(reach)
  Object.freeze(baseline.scans)
  return Object.freeze(baseline)
}

/**
 * Parse an exact on-disk baseline identity once per Bun process.
 *
 * `assertScanPopulation` calls this for every scan assertion. Path-only caching
 * would make same-path RED injections stale, so size/mtime/ctime/inode are part
 * of the key and a write immediately selects a fresh JSON snapshot.
 */
export const readScanReachBaseline = (path: string = BASELINE_PATH): ScanReachBaseline => {
  const absolute = resolve(path)
  for (;;) {
    const identity = baselineIdentity(absolute)
    const cached = baselineSnapshots.get(absolute)
    if (cached?.identity === identity) return cached.baseline
    const raw = readFileSync(absolute, "utf8")
    if (baselineIdentity(absolute) !== identity) continue
    const baseline = freezeBaseline(JSON.parse(raw) as ScanReachBaseline)
    baselineSnapshots.set(absolute, { identity, baseline })
    return baseline
  }
}

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

export const harvest = (sink: string): Map<string, ScanReach> => {
  const observed = new Map<string, ScanReach>()
  for (const line of readFileSync(sink, "utf8").split("\n")) {
    if (line === "") continue
    const r = JSON.parse(line) as { id: string; walked: number; matched?: number }
    const prev = observed.get(r.id)
    observed.set(r.id, mergeReach(prev, r))
  }
  return observed
}

const currentGitSnapshot = (): ReceiptSnapshot | undefined => {
  // BOUNDED: a wedged `git status` here stops the gate with no output at all.
  // A failed or timed-out capture reads as "no snapshot", which the caller
  // already treats as "do not reuse a receipt" — the fail-closed direction.
  const head = runBoundedCapture({ command: ["git", "rev-parse", "HEAD"] })
  const status = runBoundedCapture({ command: ["git", "status", "--porcelain=v1", "-uall"] })
  if (head.exitCode !== 0 || status.exitCode !== 0) return undefined
  return { head: head.stdout.trim(), status: status.stdout }
}

/**
 * The authority is RECOMPUTED here, against the tree, at read time.
 *
 * Discovering the full population costs one filesystem snapshot (measured 45ms
 * on this tree) and is the whole difference between checking a receipt and
 * letting it certify itself.
 */
export const currentScanReachAuthority = (repoRoot: string): ScanReachAuthority =>
  scanReachAuthorityFor({
    repoRoot,
    suite: "full",
    // NOT `"full"`: this walk applies no tier selection, and the `full` TIER is
    // a strictly smaller population than an untiered walk of the `full` SUITE.
    // Labelling it `full` is what made every receipt unusable.
    tier: UNTIERED_SCAN_POPULATION,
    files: [...discoverSuitePopulation(repoRoot, "full").files],
  })

export const readUsableShardReceipt = (
  path: string = SHARD_RECEIPT_PATH,
  current?: ScanReachAuthority,
): ReadonlyMap<string, ScanReach> | undefined => {
  if (!existsSync(path)) return undefined
  const snapshot = currentGitSnapshot()
  if (snapshot === undefined) return undefined
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8")) as ScanReachReceipt
    return observedFromReceipt(
      receipt,
      snapshot,
      current ?? currentScanReachAuthority(resolve(import.meta.dir, "..", "..")),
    )
  } catch {
    return undefined
  }
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

/**
 * The harvest has to be deterministic: it is the authority that binds every
 * baseline row to the guard that reports it. Several scan guards inspect or
 * construct process-global surfaces, and running their files in Bun's default
 * parallel workers made unrelated guards intermittently report an empty corpus
 * or fail during module construction. A failed child is correctly rejected,
 * but a flaky harvester is still not evidence. One isolated worker serializes
 * the measurement while preserving each guard's own 60s timeout.
 */
export const scanReachChildArgs = (files: readonly string[]): string[] => [
  "bun",
  "test",
  "--parallel=1",
  "--timeout=60000",
  ...files,
]

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
  // THREE sets, held equal: what the baseline pins, what the guards reported,
  // and what the ledger says each enrolled file owns. Checking only one
  // direction — "is every expected id observed" — left the other two open: an id
  // reported by a file nobody records as owning it, and a pinned row no ledger
  // entry claims. Both mean the ledger has stopped describing the tree.
  const owned = new Map<string, string>()
  for (const [file, ids] of Object.entries(run.expectedIds ?? {})) {
    for (const id of ids) owned.set(id, file)
  }
  const expectingAnything = owned.size > 0
  const missingIds = [
    ...[...owned].flatMap(([id, file]) =>
      run.observed.has(id)
        ? []
        : [
            `${file} is recorded as enrolled for "${id}", but no guard reported it — the scan ` +
              "was renamed, removed, or never ran",
          ],
    ),
    ...(expectingAnything
      ? [...run.observed.keys()].flatMap((id) =>
          owned.has(id)
            ? []
            : [
                `"${id}" was reported by a guard but no file in scan-enrollment-debt.json owns ` +
                  "it — an enrolled scan with no ledger entry is one nobody is accountable for",
              ],
        )
      : []),
    ...(expectingAnything
      ? Object.keys(run.baseline.scans).flatMap((id) =>
          owned.has(id) ? [] : [`"${id}" is pinned in the baseline but no ledger entry claims it`],
        )
      : []),
  ]
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

/** Ceiling for the harvest child: the shard runner's own per-command wall. */
const HARVEST_TIMEOUT_MS = 40 * 60_000

if (import.meta.main) {
  const receiptObserved = readUsableShardReceipt()
  let observed: ReadonlyMap<string, ScanReach>
  let childExit = 0
  let childOutput = ""
  if (receiptObserved !== undefined) {
    observed = receiptObserved
    // biome-ignore lint/suspicious/noConsole: the CLI reports its evidence source
    console.error(`scan-reach: consuming exact-HEAD shard receipt (${observed.size} scans)`)
  } else {
    const sink = `${process.env.TMPDIR ?? "/tmp"}/quanta-scan-reach-${process.pid}.jsonl`
    writeFileSync(sink, "")
    // The guards that CALL the helper, plus the tests that reach it through a
    // shared suite. `slice-boundary-scanner.ts` is not a test file and its 49
    // entrypoints never name the helper, so a list built from the direct string
    // alone leaves 49 pinned rows reporting nothing — which the STALE check then
    // fails on, correctly and unhelpfully.
    const grep = (pattern: string): readonly string[] =>
      runBoundedCapture({ command: ["git", "grep", "-l", pattern, "--", "tests", "src"] })
        .stdout.split("\n")
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
    // The repo's own suites run at `--timeout=60000`. Keep the fallback child
    // equivalent to the authoritative runner: a tighter private timeout turns
    // ordinary contention into a false regression.
    // The harvest itself: a real `bun test` over every enrolled guard file. It
    // had no ceiling at all, so a single wedged guard hung `bun run scan-reach`
    // indefinitely. The bound matches the shard runner's per-command wall
    // (40 minutes) because this is the same kind of child.
    //
    // KNOWN GAP, stated rather than implied: this is a bounded CAPTURE, not
    // `runBoundedChild`, so the ceiling signals the direct child and does not
    // reap a group. Adopting the reaper here means making this synchronous CLI
    // asynchronous, which is a separate change; the ceiling is the part that
    // was missing entirely.
    const child = runBoundedCapture({
      command: scanReachChildArgs(files),
      env: { ...process.env, QUANTA_SCAN_REACH_RECORD: sink },
      timeoutMs: HARVEST_TIMEOUT_MS,
    })
    if (child.timedOut) {
      process.stderr.write(
        `scan-reach: harvest KILLED at the ${HARVEST_TIMEOUT_MS}ms ceiling; ` +
          "the reach numbers below describe an incomplete run and are refused\n",
      )
    }
    // A killed child has no exit code of its own. 124 is `timeout(1)`'s
    // convention for "the ceiling fired", and it must be NON-ZERO: a harvest
    // that was killed measured an incomplete run, and `childExit === 0` is what
    // licenses the reach numbers.
    childExit = child.exitCode ?? 124
    childOutput = `${child.stdout}${child.stderr}`
    observed = harvest(sink)
    rmSync(sink, { force: true })
  }
  const baseline = readScanReachBaseline()
  const debt = JSON.parse(
    readFileSync(join(import.meta.dir, "scan-enrollment-debt.json"), "utf8"),
  ) as { expectedIds?: Readonly<Record<string, readonly string[]>> }
  const verdict = decide({
    childExit,
    observed,
    baseline,
    tighten: process.argv.includes("--tighten"),
    ...(debt.expectedIds === undefined ? {} : { expectedIds: debt.expectedIds }),
  })
  for (const line of verdict.lines) {
    // biome-ignore lint/suspicious/noConsole: the CLI reports to the operator
    console.error(line)
  }
  if (verdict.exit !== 0 && childExit !== 0) {
    // The child's own output is the actionable part when the guards failed.
    // biome-ignore lint/suspicious/noConsole: the CLI reports to the operator
    console.error(childOutput.slice(-4000))
  }
  if (verdict.doTighten) tighten(observed, baseline)
  process.exit(verdict.exit)
}
