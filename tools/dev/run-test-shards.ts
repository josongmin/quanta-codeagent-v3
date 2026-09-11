import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism, freemem, loadavg, tmpdir, totalmem } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import {
  type ExecutedFileSetVerdict,
  executedFileSetDigest,
  executedFileSetVerdict,
} from "./executed-file-set"
import {
  buildFailureAttemptArtifact,
  failureRecordsFromJunit,
  writeFailureAttemptArtifact,
} from "./failure-attempt-producer"
import { quarantineLane, quarantinePath } from "./lease-quarantine"
import { AUTHORITATIVE_SCAN_TIERS, scanReachAuthorityFor } from "./scan-reach-authority"
import {
  describeWatchdogKill,
  isKill,
  shardWatchdogAction,
  spoolTailWindow,
} from "./shard-output-budget"
import { sampleTreeRssBytes } from "./shard-rss"
import {
  loadPolicyOverrides,
  policyDigest,
  resolveTestPopulation,
  selectTestPoliciesForTier,
} from "./test-policy"
import { loadTestResourceCertificationsSafe } from "./test-resource-certification"
import { resolveChunkCacheScope } from "./test-shard-cache-scope"
import {
  discoverInventory,
  discoverSuiteFiles,
  SUITE_FLOORS,
  type SuiteName,
} from "./test-shard-discovery"
import {
  acquireTestShardLease,
  confirmLeaseToken,
  inheritedTestShardLeaseState,
  normalizeRepositoryIdentity,
  readCommittedRepositoryLeaseId,
  selectRepositoryLeaseIdentity,
  type TestShardLease,
  testShardLeasePort,
  VERIFICATION_LEASE_OWNER_IDENTITY_ENV,
} from "./test-shard-lease"
import {
  describeProcessGroup,
  drainCampaign,
  runResourceAwareSchedule,
  ShardProcessRegistry,
  terminateCampaignOnSignal,
} from "./test-shard-lifecycle"
import { parseShardRunnerOptions, type RunnerOptions } from "./test-shard-options"
import {
  chooseIntraWorkerParallelism,
  chooseShardConcurrency,
  chooseShardTestTimeoutMs,
  nextOverloadDelayMs,
  parseExecutedFileCount,
  planTestChunks,
  resourceClassesOverlap,
  spoolTail,
  type TestChunk,
  type TestResourceClass,
} from "./test-shard-plan"
import {
  chunkCacheNamespace,
  loadSuccessfulTestShardReceipt,
  mergeScanReachSinks,
  pruneExpiredShardReceipts,
  type SuccessfulTestShardReceipt,
  shardFilesSha256,
  type TestShardCacheIdentity,
  testEnvironmentSha256,
  testRuntimeSha256,
  testShardCacheIdentitySha256,
  trackedTreeSha256,
  writeScanReachReceiptAtomic,
  writeSuccessfulTestShardReceiptAtomic,
} from "./test-shard-receipt"
import { type ShardSelection, selectShardManifest } from "./test-shard-selection"
import { currentTimeoutPolicy, timeoutPolicySha256 } from "./test-shard-timeout-policy"
import {
  harvestChunkTimingObservations,
  junitExecutedFiles,
  loadTestTimings,
  openTimingJournal,
  receiptTimingSamples,
  recoverAbandonedTimingJournals,
  type TimingJournal,
  type TimingSample,
} from "./test-shard-timings"
import { loadTierPopulationFloors } from "./test-tier-population"
import { ADMISSION_DEADLINE_ENV } from "./verification-admission"
import { executionPolicyDigest } from "./verification-execution-policy"
import { sharedVerificationCacheRoot } from "./verification-receipt"
import { applyUserLibraryDecision, type UserLibraryDecision } from "./worker-home"

/**
 * Authoritative local full-suite runner.
 *
 * Bun's one-process full run exhausts JSC on this repository. The worker
 * script remains available as `test:shard`, but this runner owns the full
 * verdict: it discovers the manifest exactly once, gives each worker explicit
 * file paths, overlaps at most two resource-isolated workers, records every
 * exit, and refuses to bless a result if another session changed the checkout.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const SCAN_REACH_RECEIPT = join(REPO_ROOT, ".cache", "scan-reach-receipt.json")
// Shard receipts and timings live in the git-common-dir cache: keyed by exact
// HEAD + file content + toolchain, a green from any worktree serves them all.
const SHARED_CACHE_ROOT = sharedVerificationCacheRoot(REPO_ROOT)
const QUARANTINE_PATH = quarantinePath(SHARED_CACHE_ROOT)
const SHARD_CACHE_ROOT = join(SHARED_CACHE_ROOT, "test-shards", "v3")
const TIMING_STORE = join(SHARED_CACHE_ROOT, "test-timings-v2.json")

/**
 * Every shard-cache root version this checkout could still be holding bytes for.
 *
 * A root version bump orphans the previous one WHOLESALE: nothing reaches it
 * again, so nothing collects it. Measured on this checkout while wiring the
 * namespace-complete prune, the superseded `v2` root held 307 receipts and
 * 127 MiB, every one expired. Sweeping by TTL across all versions costs one
 * `readdir` per root and removes the only thing that made a cache bump a leak.
 */
const shardCacheRootsToSweep = (): readonly string[] => {
  const base = join(SHARED_CACHE_ROOT, "test-shards")
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^v\d+$/u.test(entry.name))
      .map((entry) => join(base, entry.name))
      .sort()
  } catch {
    // No cache yet. Nothing to sweep is the correct answer, not an error.
    return []
  }
}

/** TTL-only collection across every cache root version, reported when it bites. */
const sweepExpiredShardCaches = (): void => {
  for (const root of shardCacheRootsToSweep()) {
    const pruned = pruneExpiredShardReceipts(root)
    if (pruned.removed === 0) continue
    process.stderr.write(
      `[test:shards] cache GC removed ${pruned.removed} expired receipt(s) ` +
        `(${Math.round(pruned.bytesReclaimed / 1024 ** 2)} MiB) across ` +
        `${pruned.namespaces.length} namespace(s) under ${root}; kept ${pruned.kept}\n`,
    )
  }
}
const TEST_POLICY_OVERRIDES = join(REPO_ROOT, "tools", "dev", "test-policy-overrides.json")
// Extreme-load regime: the same load/(2*cpus) pressure formula that saturates
// the per-test timeout cap. At or beyond it, starting a fresh worker mostly
// deepens the thrash, so the runner briefly WAITS (bounded) instead.
const START_DELAY_PRESSURE = 4
const START_DELAY_POLL_MS = 30_000
const START_DELAY_MAX_MS = 10 * 60_000
// The shard corpus contains cold-path source scans and real CLI integration
// rails. A normal shard can exceed twelve minutes while continuously reporting
// completed tests on a contended host, so a total wall-clock cap discards valid
// coverage. This is instead a *progress* watchdog: a CPU-bound Bun worker that
// ignores Bun's per-test timeout eventually goes silent and is still killed,
// while an active shard retains its complete corpus verdict.
const SHARD_INACTIVITY_TIMEOUT_MS = 12 * 60_000
/** Enough to carry a stack or a stuck server's last exchange, short enough
 *  that the kill notice stays readable in a 30-chunk log. */
const WATCHDOG_TAIL_LINES = 20

const SHARD_WATCHDOG_POLL_MS = 1_000
/**
 * A chunk may not outlive this, however chatty it is.
 *
 * There was NO total wall bound: only a 12-minute inactivity timer that any
 * byte reset. A worker in a `console.log` loop was maximally "alive" by that
 * measure and ran to the JOB timeout — the outer boundary the watchdog exists to
 * stay inside. 40 minutes is roughly 3x the inactivity window and far above any
 * observed chunk.
 */
const SHARD_TOTAL_WALL_TIMEOUT_MS = 40 * 60_000
/**
 * Past this many bytes, continued output stops counting as progress.
 *
 * Not a style rule about logging. The spool is the complete stdout+stderr of up
 * to 160 test files; 512MiB is far beyond any real suite and is the point at
 * which "still writing" has stopped being evidence of anything.
 */
const SHARD_OUTPUT_CAP_BYTES = 512 * 1024 * 1024
/** How much of the spool to replay at the end. The whole file used to be read
 *  into memory twice — the reaction to a pathological producer was to load
 *  everything it produced. */
const SPOOL_REPLAY_BYTES = 8 * 1024 * 1024
const SOURCE_JS_CLEANED_ROOT_ENV = "QUANTA_TEST_SOURCE_JS_CLEANED_ROOT"
const SOURCE_ROOT = join(REPO_ROOT, "src")
const PRESERVED_SOURCE_JS = new Set([join(SOURCE_ROOT, "ui", "auth-ui.js")])

export const findStaleSourceJs = (sourceRoot: string): readonly string[] => {
  const stale: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        path.endsWith(".js") &&
        !PRESERVED_SOURCE_JS.has(path)
      ) {
        stale.push(path)
      }
    }
  }
  visit(sourceRoot)
  return stale.sort((left, right) => left.localeCompare(right))
}

const preflightSourceJs = async (): Promise<void> => {
  // Suppress the preload module's direct-test fallback during import, then call
  // its managed-campaign entrypoint exactly once under the repository lease.
  process.env[SOURCE_JS_CLEANED_ROOT_ENV] = SOURCE_ROOT
  const cleanup = await import("../../tests/preload-clean-source-js")
  if (
    cleanup.SOURCE_JS_CLEANED_ROOT_ENV !== SOURCE_JS_CLEANED_ROOT_ENV ||
    cleanup.SOURCE_ROOT !== SOURCE_ROOT ||
    cleanup.cleanStaleSourceJs() !== SOURCE_ROOT
  ) {
    throw new Error("[test:shards] stale source-JS cleanup contract mismatch")
  }
}

const assertNoNewSourceJs = async (): Promise<void> => {
  const stale = findStaleSourceJs(SOURCE_ROOT)
  if (stale.length === 0) return
  const cleanup = await import("../../tests/preload-clean-source-js")
  cleanup.cleanStaleSourceJs()
  throw new Error(
    `[test:shards] INVALID — test workers emitted ${stale.length} stale source .js file(s):\n` +
      stale.map((path) => `  - ${relative(REPO_ROOT, path)}`).join("\n"),
  )
}

interface GitSnapshot {
  readonly head: string
  readonly status: string
}

const capture = async (
  cmd: readonly string[],
): Promise<{ readonly code: number; readonly text: string }> => {
  const proc = Bun.spawn({ cmd: [...cmd], cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, text: `${stdout}${stderr}` }
}

const gitSnapshot = async (): Promise<GitSnapshot> => {
  const [head, status] = await Promise.all([
    capture(["git", "rev-parse", "HEAD"]),
    capture(["git", "status", "--porcelain"]),
  ])
  if (head.code !== 0 || status.code !== 0) {
    throw new Error(`test shards require a readable Git checkout: ${head.text}${status.text}`)
  }
  return { head: head.text.trim(), status: status.text }
}

const sameSnapshot = (left: GitSnapshot, right: GitSnapshot): boolean =>
  left.head === right.head && left.status === right.status

const manifestSha256 = (manifest: readonly string[]): string =>
  new Bun.CryptoHasher("sha256")
    .update(manifest.map((file) => relative(REPO_ROOT, file)).join("\0"))
    .digest("hex")

const macAvailableMemory = async (): Promise<number | undefined> => {
  if (process.platform !== "darwin") return undefined
  const result = await capture(["vm_stat"])
  if (result.code !== 0) return undefined
  const pageSize = /page size of (\d+) bytes/.exec(result.text)?.[1]
  if (pageSize === undefined) return undefined
  const reclaimable = ["Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"]
  let pages = 0
  for (const label of reclaimable) {
    const value = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(result.text)?.[1]
    if (value !== undefined) pages += Number.parseInt(value, 10)
  }
  return pages * Number.parseInt(pageSize, 10)
}

const workerConcurrency = async (): Promise<1 | 2> =>
  chooseShardConcurrency({
    totalBytes: totalmem(),
    availableBytes: (await macAvailableMemory()) ?? freemem(),
  })

const writeScanReachReceipt = (input: {
  readonly head: string
  readonly suite: SuiteName
  readonly tier: string | undefined
  readonly manifest: readonly string[]
  readonly manifestSha256: string
  readonly sinks: readonly string[]
}): void => {
  // Only full covers every enrolled scan id, and only an unnarrowed tier walks
  // all of it. A `unit` suite or a `pr` tier run is internally successful and
  // describes a DIFFERENT population; minting a receipt for it is how a floor
  // ratchet ends up reading a subset as a regression.
  if (input.suite !== "full") return
  const tier = input.tier ?? "full"
  if (!AUTHORITATIVE_SCAN_TIERS.includes(tier)) return
  writeScanReachReceiptAtomic({
    path: SCAN_REACH_RECEIPT,
    head: input.head,
    manifestSha256: input.manifestSha256,
    sinks: input.sinks,
    authority: scanReachAuthorityFor({
      repoRoot: REPO_ROOT,
      suite: "full",
      tier,
      files: input.manifest,
    }),
  })
}

const parseOptions = parseShardRunnerOptions

const junitShardPath = (junitOut: string, index: number): string => `${junitOut}.shard-${index}.xml`

/** Content-addressed: the same chunk composition reuses its receipt even when
 *  the chunk's ordinal shifted because a NEIGHBOR chunk changed. */
/**
 * The path must separate what the IDENTITY separates.
 *
 * It was keyed on the chunk's own test files alone, while a hit additionally
 * requires the tree, manifest, toolchain and env to match. Most commits do not
 * touch test files, so two worktrees at different commits mapped to the SAME
 * file: each read the other's receipt, missed on identity, re-ran, and
 * overwrote it — so the shared cache thrashed to zero hits in exactly the
 * many-worktree case it was built for. Adding the tree keeps them side by side;
 * TTL pruning still bounds the directory.
 */
const chunkCachePath = (identity: TestShardCacheIdentity): string =>
  join(
    SHARD_CACHE_ROOT,
    chunkCacheNamespace(identity),
    `chunk-${testShardCacheIdentitySha256(identity)}.json`,
  )

const prepareJunit = (junitOut: string, indices: readonly number[]): void => {
  // Bun's JUnit reporter does not create the target directory; on a fresh
  // checkout (no .cache/ yet) the worker would pass its tests and then die
  // writing the receipt.
  mkdirSync(dirname(resolve(REPO_ROOT, junitOut)), { recursive: true })
  rmSync(junitOut, { force: true })
  for (const index of indices) rmSync(junitShardPath(junitOut, index), { force: true })
}

const junitBody = (xml: string, index: number): string => {
  const root = xml.indexOf("<testsuites")
  const open = root < 0 ? -1 : xml.indexOf(">", root)
  const close = xml.lastIndexOf("</testsuites>")
  if (root < 0 || open < 0 || close < 0 || !xml.includes("<testcase")) {
    throw new Error(`[test:shards] invalid JUnit receipt from chunk ${index}`)
  }
  return xml.slice(open + 1, close).trim()
}

const mergeJunit = (junitOut: string, indices: readonly number[]): void => {
  const bodies: string[] = []
  for (const index of indices) {
    bodies.push(junitBody(readFileSync(junitShardPath(junitOut, index), "utf8"), index))
  }
  writeFileSync(
    junitOut,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test sharded">\n${bodies.join("\n")}\n</testsuites>\n`,
  )
}

/**
 * Chrome's HOME dependency, scoped to the lane that actually has one.
 *
 * The scratch HOME exists so a test cannot read the developer's real
 * `~/.quanta`; QUANTA_HOME and QUANTA_PREFS_HOME are set explicitly, so that
 * protection never depended on HOME being empty — only on those pointing
 * somewhere else, which they still do.
 *
 * What DID depend on it was Chrome, and the failure is environmental rather
 * than ours. Measured with a raw CDP probe (no adapter involved), six cold
 * HOMEs each: `Page.navigate` completed 2/6 times. When it failed, NOTHING
 * arrived — no `responseReceived`, no `frameStoppedLoading`, no
 * `loadEventFired` — so the fetch never started and there is no alternative
 * completion signal to wait on instead. With the real Library lent in, the
 * same probe was 6/6. Neither `--disable-background-networking`/
 * `--disable-component-update` nor forcing an inert `about:blank` initial
 * target moved the rate; an EMPTY Library skeleton measures like no Library
 * at all, which is why an earlier persistent-but-cold directory did not help.
 *
 * WHAT CHANGED. That measurement licensed a Chrome workaround; it was applied
 * to EVERY worker. A full suite plans 44 chunks and 12 files classify
 * `browser` (only three of which drive a real Chrome — the rest match the
 * detector on a string literal), so ~43 of 44 workers were handed a symlink to
 * the developer's entire `~/Library` for a browser they never start. That is
 * real user state — Mail, Keychains, Safari, Messages, every app's Application
 * Support — reachable from any test that resolves HOME, on a host where tests
 * routinely spawn shells. It is also invisible to cache identity and absent on
 * Linux CI, so the local and hosted lanes were not running the same thing.
 *
 * The lend is now scoped to `browser` chunks, and `QUANTA_TEST_NO_USER_LIBRARY=1`
 * removes it entirely (the browser lane then inherits the measured 1-in-3
 * navigate). Retiring it for the browser lane too needs the Chrome capability
 * producer to own a disposable profile and re-measure the navigate rate — until
 * that receipt exists, silently dropping it here would trade a safety defect
 * for a flake nobody could attribute.
 *
 * Returns what it did, so the worker's own log says which HOME it ran under.
 */
const lendRealUserLibrary = (
  workerHome: string,
  resourceClass: TestResourceClass,
): UserLibraryDecision | "unavailable" => applyUserLibraryDecision({ workerHome, resourceClass })

interface ShardRunResult {
  readonly code: number
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly executedFiles?: number
  readonly scanReachSink: string
  readonly junitPath: string
  readonly elapsedMs: number
}

const runShard = async (
  plan: TestChunk,
  totalChunks: number,
  opts: RunnerOptions,
  runRoot: string,
  testTimeoutMs: number,
  registry: ShardProcessRegistry,
  intraParallel: number,
): Promise<ShardRunResult> => {
  const shard = `${plan.index}/${totalChunks}`
  const workerRootEarly = join(runRoot, `worker-${plan.index}`)
  const junitPath =
    opts.junitOut === undefined
      ? join(workerRootEarly, `junit-${plan.index}.xml`)
      : junitShardPath(opts.junitOut, plan.index)
  const scanReachSink = join(workerRootEarly, `scan-reach-${plan.index}.jsonl`)
  const junitArgs = ["--reporter=junit", `--reporter-outfile=${junitPath}`]
  process.stdout.write(
    `\n[test:shards] START chunk=${shard} files=${plan.files.length} class=${plan.resourceClass} ` +
      `predicted_ms=${plan.predictedMs} intra_parallel=${intraParallel}\n`,
  )
  // Native file descriptors keep the child off a JS relay/backpressure path.
  // Relaying every Bun test chunk through this process more than doubled a
  // measured full shard (375s direct versus the 720s kill boundary) and turned
  // a green worker into a runner timeout. Spool natively, then replay once so
  // the receipt still contains the complete worker output and discovery banner.
  const workerRoot = workerRootEarly
  const workerTmp = join(workerRoot, "tmp")
  const workerHome = join(workerRoot, "home")
  const quantaHome = join(workerHome, ".quanta")
  const prefsHome = join(workerRoot, "prefs-home")
  const benchResults = join(workerRoot, "bench-results")
  mkdirSync(workerTmp, { recursive: true })
  mkdirSync(quantaHome, { recursive: true })
  const userLibrary = lendRealUserLibrary(workerHome, plan.resourceClass)
  mkdirSync(prefsHome, { recursive: true })
  mkdirSync(benchResults, { recursive: true })
  process.stdout.write(`[test:shards] chunk=${shard} user_library=${userLibrary}\n`)
  const spoolPath = join(workerRoot, `chunk-${plan.index}.log`)
  writeFileSync(scanReachSink, "")
  const spoolFd = openSync(spoolPath, "w")
  // Admission is complete before the shard runner starts. Never expose a
  // stale startup deadline to test code that may launch another local gate.
  const workerEnv = { ...process.env }
  delete workerEnv[ADMISSION_DEADLINE_ENV]
  workerEnv[SOURCE_JS_CLEANED_ROOT_ENV] = SOURCE_ROOT
  let closed = false
  try {
    const startedAt = performance.now()
    // Detached: the worker leads its OWN process group, so cancellation and
    // the watchdog can kill the whole descendant tree (browsers, language
    // servers) with one kill(-pgid) instead of only the direct Bun child.
    const handle = registry.spawnWorker({
      cmd: [
        "bun",
        "test",
        ...plan.files,
        `--timeout=${testTimeoutMs}`,
        `--parallel=${intraParallel}`,
        // A failed real-browser/LSP setup often poisons the remaining tests in
        // that file and turns one actionable failure into minutes of derivative
        // timeouts. The shard verdict is already red after the first failure;
        // stop the Bun child immediately instead of spending time on evidence
        // that cannot change the verdict.
        "--bail=1",
        ...junitArgs,
      ],
      cwd: REPO_ROOT,
      env: {
        ...workerEnv,
        HOME: workerHome,
        TMPDIR: workerTmp,
        PWD: REPO_ROOT,
        QUANTA_HOME: quantaHome,
        QUANTA_PREFS_HOME: prefsHome,
        QUANTA_BENCH_RESULTS_DIR: benchResults,
        QUANTA_SCAN_REACH_RECORD: scanReachSink,
        QUANTA_TEST_TIMEOUT_SCALE: String(testTimeoutMs / 60_000),
      },
      stdoutFd: spoolFd,
      stderrFd: spoolFd,
    })
    let peakRssBytes = 0
    const progress = setInterval(() => {
      const elapsedSeconds = Math.round((performance.now() - startedAt) / 1_000)
      const spoolBytes = statSync(spoolPath).size
      process.stdout.write(
        `[test:shards] PROGRESS chunk=${shard} class=${plan.resourceClass} elapsed=${elapsedSeconds}s ` +
          `spool_bytes=${spoolBytes} peak_rss_sampled_bytes=${peakRssBytes}\n`,
      )
    }, 60_000)
    progress.unref()
    let timedOut = false
    let lastProgressAt = Date.now()
    let lastSpoolBytes = 0
    let watchdogTicks = 0
    const timeout = setInterval(() => {
      watchdogTicks += 1
      if (watchdogTicks % 15 === 0) {
        peakRssBytes = Math.max(peakRssBytes, sampleTreeRssBytes(handle.pid))
      }
      const spoolBytes = statSync(spoolPath).size
      const idleMs = Date.now() - lastProgressAt
      const tick = {
        spoolBytes,
        lastSpoolBytes,
        idleMs,
        elapsedMs: Math.round(performance.now() - startedAt),
        inactivityTimeoutMs: SHARD_INACTIVITY_TIMEOUT_MS,
        totalWallTimeoutMs: SHARD_TOTAL_WALL_TIMEOUT_MS,
        outputCapBytes: SHARD_OUTPUT_CAP_BYTES,
        alreadyKilling: timedOut,
      }
      const action = shardWatchdogAction(tick)
      if (action === "progressed") {
        lastSpoolBytes = spoolBytes
        lastProgressAt = Date.now()
        return
      }
      if (!isKill(action)) return
      timedOut = true
      // Say what it was doing, and WHICH bound it crossed. A chunk holds ~100
      // files, and "idle=600000ms" over all of them is not a lead; the last
      // thing the worker wrote is.
      process.stderr.write(
        `[test:shards] TIMEOUT chunk=${shard} ${describeWatchdogKill(action, tick)}; ` +
          `killing worker process tree.\nProcess group (pgid pid ppid stat %cpu elapsed cmd):\n` +
          `${describeProcessGroup(handle.pid)}\nLast output:\n` +
          `${spoolTail(readSpoolTail(spoolPath, SPOOL_REPLAY_BYTES), WATCHDOG_TAIL_LINES)}\n`,
      )
      void handle.cancel()
    }, SHARD_WATCHDOG_POLL_MS)
    const exit = await handle.exited
    clearTimeout(timeout)
    clearInterval(progress)
    closeSync(spoolFd)
    closed = true
    const code = exit.code ?? -1
    const spoolBytes = statSync(spoolPath).size
    // The TAIL, not the file. A chunk that wrote past the replay window says so
    // rather than silently handing back a truncated log.
    const output = readSpoolTail(spoolPath, SPOOL_REPLAY_BYTES)
    if (spoolBytes > SPOOL_REPLAY_BYTES) {
      process.stdout.write(
        `[test:shards] chunk=${shard} spool is ${spoolBytes} bytes; replaying the last ` +
          `${SPOOL_REPLAY_BYTES}. Full output: ${spoolPath}\n`,
      )
    }
    process.stdout.write(output)
    const executedFiles = parseExecutedFileCount(output)
    const elapsedMs = Math.round(performance.now() - startedAt)
    process.stdout.write(
      `[test:shards] END chunk=${shard} exit=${code} signal=${exit.signal ?? "none"}` +
        `${timedOut ? " timeout" : ""}${handle.cancelled && !timedOut ? " cancelled" : ""} ` +
        `elapsed_ms=${elapsedMs} peak_rss_sampled_bytes=${peakRssBytes} spool_bytes=${spoolBytes}\n`,
    )
    const cancelled = handle.cancelled
    return executedFiles === undefined
      ? { code, timedOut, cancelled, scanReachSink, junitPath, elapsedMs }
      : { code, timedOut, cancelled, executedFiles, scanReachSink, junitPath, elapsedMs }
  } finally {
    if (!closed) closeSync(spoolFd)
  }
}

interface CompletedShard {
  readonly plan: TestChunk
  readonly totalChunks: number
  readonly result: ShardRunResult
  readonly snapshot: GitSnapshot
  /** Replay context for the failure artifact: what this attempt ran under. */
  readonly suite: string
  readonly workerParallel: number
  readonly intraParallel: number
  readonly testTimeoutMs: number
}

interface CachedChunk {
  readonly chunk: TestChunk
  readonly identity: TestShardCacheIdentity
  readonly cachePath: string
  /** Decided once, at plan time, so the receipt's identity and the run agree. */
  readonly intraParallel: number
  /** Why this chunk got the cache scope it did, recorded in the receipt. */
  readonly scopeReason: string
}

/** Where the authoritative attempt's failures are published. */
const FAILURE_ATTEMPT_PATH = join(SHARED_CACHE_ROOT, "failure-attempt.json")

/**
 * Publish the first failing chunk's failures, or `undefined` when there is
 * nothing to publish.
 *
 * Never throws into the failure path: a campaign that has already failed must
 * report THAT, not an error from writing a diagnostic aid.
 */
const emitFailureAttempt = (
  plan: TestChunk,
  result: ShardRunResult,
  snapshot: GitSnapshot,
  completed: CompletedShard,
): string | undefined => {
  try {
    const junitXml = readFileSync(result.junitPath, "utf8")
    const failures = failureRecordsFromJunit(junitXml, plan.index)
    const artifact = buildFailureAttemptArtifact({
      head: snapshot.head,
      dirty: snapshot.status !== "",
      suite: completed.suite,
      replay: {
        // The runner does not seed Bun's ordering, and saying so is the honest
        // answer: a fabricated seed would make a replay look reproducible when
        // it is not. TVH-15 owns closing this.
        seed: "<unseeded>",
        permutation: shardFilesSha256(REPO_ROOT, plan.files),
        cores: availableParallelism(),
        loadAverage1m: loadavg()[0] ?? 0,
        workerParallel: completed.workerParallel,
        intraParallel: completed.intraParallel,
        testTimeoutMs: completed.testTimeoutMs,
        resourceClaims: plan.claims.map((claim) => `${claim.key}:${claim.mode}`),
        // Authoritative by construction: this is the ORIGINAL attempt, written
        // before anything retried it.
        retryCount: 0,
      },
      failures,
    })
    return writeFailureAttemptArtifact(FAILURE_ATTEMPT_PATH, artifact)
      ? FAILURE_ATTEMPT_PATH
      : undefined
  } catch (error) {
    process.stderr.write(
      `[test:shards] WARN could not publish the failure artifact: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return undefined
  }
}

/**
 * Did this chunk run the files it was planned?
 *
 * Reads the worker's own JUnit — an artifact the runner does not write — and
 * compares the EXACT set. The predecessor compared `result.executedFiles ===
 * plan.files.length`, so 147 of somebody else's files was a pass, and the
 * timing and cache receipts it minted claimed the planned set had been run.
 *
 * A JUnit that cannot be read is a failure to prove, not a proof: there is no
 * fallback to the count.
 */
const executedSetOf = (plan: TestChunk, result: ShardRunResult): ExecutedFileSetVerdict => {
  let junitXml: string
  try {
    junitXml = readFileSync(result.junitPath, "utf8")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      executed: [],
      digestSha256: executedFileSetDigest([]),
      missing: [...plan.files],
      unexpected: [],
      duplicate: [],
      reason: `junit unreadable at ${result.junitPath}: ${message}`,
    }
  }
  return executedFileSetVerdict({
    repoRoot: REPO_ROOT,
    plannedRaw: plan.files,
    executedRaw: junitExecutedFiles(junitXml),
  })
}

const validateCompletedShard = (before: GitSnapshot, completed: CompletedShard): string => {
  const { plan, totalChunks, result, snapshot } = completed
  if (!sameSnapshot(before, snapshot)) {
    throw new Error(
      `[test:shards] INVALID — checkout changed after chunk ${plan.index}/${totalChunks} ` +
        `(start=${before.head}, current=${snapshot.head}). Aborting remaining shards.`,
    )
  }
  if (result.code === 0 && !result.timedOut) {
    const set = executedSetOf(plan, result)
    if (!set.ok) {
      throw new Error(
        `[test:shards] EXECUTED-SET MISMATCH chunk=${plan.index}/${totalChunks} — the worker ` +
          `exited 0 but did not run the planned files: ${set.reason}`,
      )
    }
    return result.scanReachSink
  }
  if (result.cancelled && !result.timedOut) {
    // Derivative outcome: this worker was killed because a PEER failed (or the
    // campaign was signalled). Keep it distinguishable from a genuine red.
    throw new Error(
      `[test:shards] CANCELLED chunk=${plan.index}/${totalChunks} after peer failure or ` +
        "termination; aborting remaining shards",
    )
  }
  // The AUTHORITATIVE attempt, written down before the campaign aborts.
  // `failure-artifact.ts` states this contract in its own header — "the runner
  // that actually holds the lease writes this artifact" — and nothing wrote
  // one, so the diagnostic tool could only ever be driven by a hand-authored
  // file and its fail-closed was the only path it ever took.
  const artifactPath = emitFailureAttempt(plan, result, snapshot, completed)
  const discovery =
    result.executedFiles === undefined ? "missing" : `${result.executedFiles}/${plan.files.length}`
  throw new Error(
    `[test:shards] FAILED chunk=${plan.index}/${totalChunks} exit=${result.code} ` +
      `timeout=${result.timedOut ? "yes" : "no"} discovery=${discovery}; ` +
      "aborting remaining shards" +
      (artifactPath === undefined ? "" : `\n[test:shards] failure artifact: ${artifactPath}`),
  )
}

const materializeCachedScanReachSink = (
  runRoot: string,
  receipt: SuccessfulTestShardReceipt,
): string => {
  const cacheWorkerRoot = join(runRoot, `cached-worker-${receipt.shardIndex}`)
  mkdirSync(cacheWorkerRoot, { recursive: true })
  const sink = join(cacheWorkerRoot, `scan-reach-${receipt.shardIndex}.jsonl`)
  writeFileSync(
    sink,
    receipt.scanReachRecords.map((record) => JSON.stringify(record)).join("\n") +
      (receipt.scanReachRecords.length === 0 ? "" : "\n"),
  )
  return sink
}

const materializeCachedJunit = (
  opts: RunnerOptions,
  chunkIndex: number,
  receipt: SuccessfulTestShardReceipt,
): void => {
  if (opts.junitOut === undefined) return
  if (receipt.junitXml === undefined) {
    throw new Error(`[test:shards] cached chunk ${chunkIndex} lost its JUnit receipt`)
  }
  junitBody(receipt.junitXml, chunkIndex)
  // The CURRENT chunk index, not the receipt's: the ordinal can shift when a
  // neighbor chunk's composition changed while this one stayed identical.
  writeFileSync(junitShardPath(opts.junitOut, chunkIndex), receipt.junitXml)
}

/**
 * Measured per-file wall time for one green chunk.
 *
 * The observations are BOTH the receipt's timing evidence and the journal's
 * entry, so a cache hit can rehydrate what the executed run measured. A green
 * receipt whose timing write was lost used to be unrepairable: every later
 * campaign hit it, never re-ran the chunk, and the speed budget stayed red.
 */
const chunkTimingObservations = (
  cached: CachedChunk,
  result: ShardRunResult,
  junitXml: string,
): ReadonlyMap<string, TimingSample> => {
  // Bun writes the JUnit `file` attribute RELATIVE to the worker's cwd (the
  // repo root) even when the command line carried absolute paths, so the
  // harvest must look suites up by the same relative key (measured on 1.3.14).
  const relFiles = cached.chunk.files.map((file) => relative(REPO_ROOT, file))
  return harvestChunkTimingObservations(junitXml, relFiles, result.elapsedMs, {
    runnerClass: cached.chunk.resourceClass,
    policyDigest: cached.identity.executionPolicySha256,
    intraParallel: cached.intraParallel,
    loadPerCore: Math.max(0, (loadavg()[0] ?? 0) / availableParallelism()),
  })
}

const cacheSuccessfulShard = (
  cached: CachedChunk,
  result: ShardRunResult,
  opts: RunnerOptions,
  journal: TimingJournal,
  testTimeoutMs: number,
): void => {
  const junitXml = readFileSync(result.junitPath, "utf8")
  // The receipt records what the JUNIT says ran, not what the runner launched.
  // `validateCompletedShard` has already refused any chunk whose set differs,
  // so this is the proven set — re-derived here rather than passed along, so a
  // future caller cannot hand this function a set nothing verified.
  const executedSet = executedFileSetVerdict({
    repoRoot: REPO_ROOT,
    plannedRaw: cached.chunk.files,
    executedRaw: junitExecutedFiles(junitXml),
  })
  if (!executedSet.ok) {
    throw new Error(
      `[test:shards] refusing to cache chunk ${cached.chunk.index}: ${executedSet.reason}`,
    )
  }
  junitBody(junitXml, cached.chunk.index)
  const observations = chunkTimingObservations(cached, result, junitXml)
  // One APPEND per chunk. The store itself is written once, at campaign end —
  // it used to be read, sorted and rewritten on every chunk completion, up to
  // 44 whole-store rewrites per full campaign. Timing is a scheduler hint and
  // never a verdict input, so a journal failure is reported and the run goes on.
  try {
    journal.record(observations)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[test:shards] WARN timing journal failed for chunk ${cached.chunk.index}: ${message}\n`,
    )
  }
  if (opts.cacheMode === "off") return
  writeSuccessfulTestShardReceiptAtomic({
    path: cached.cachePath,
    identity: { ...cached.identity, junit: true },
    executedFileIds: executedSet.executed,
    scanReachRecords: mergeScanReachSinks([result.scanReachSink]),
    testTimeoutMs,
    timingObservations: [...observations].map(([file, sample]) => ({ file, ...sample })),
    scopeReason: cached.scopeReason,
    junitXml,
  })
}

const loadPressure = (): number => {
  const cpuCount = availableParallelism()
  const loadAverage1m = loadavg()[0] ?? 0
  return Math.max(1, Math.ceil(loadAverage1m / (cpuCount * 2)))
}

/**
 * Measured before EVERY worker start: reclaimable memory picks 1 or 2 workers
 * (same validated thresholds as before), and CPU pressure above 1 quantum —
 * the same load/(2*cpus) formula that scales test timeouts — drops overlap to
 * a single worker instead of inflating timeouts further. In the extreme
 * regime (pressure >= START_DELAY_PRESSURE) with NOTHING running, the runner
 * waits (bounded) for the host to recover before occupying it.
 */
/**
 * The overload delay is a CAMPAIGN budget, not a per-start one.
 *
 * It used to be a fresh 10-minute deadline on every start with an empty box —
 * which, in a serial campaign, is every chunk. A host that stays loaded could
 * therefore stretch 30 chunks by 10 minutes each and spend five hours mostly
 * asleep, having reported nothing but "delaying" lines. Yielding to a busy box
 * is worth a bounded amount of time in total; past that the campaign is better
 * off running slowly than not running.
 */
let overloadDelayBudgetMs = START_DELAY_MAX_MS

const measuredConcurrency = async (runningCount: number): Promise<number> => {
  if (runningCount === 0) {
    let pressure = loadPressure()
    let sleepMs = nextOverloadDelayMs({
      pressure,
      budgetLeftMs: overloadDelayBudgetMs,
      pollMs: START_DELAY_POLL_MS,
      thresholdPressure: START_DELAY_PRESSURE,
    })
    while (sleepMs > 0) {
      process.stdout.write(
        `[test:shards] OVERLOADED load_pressure=${pressure} load_1m=${(loadavg()[0] ?? 0).toFixed(2)}; ` +
          `delaying next worker start ${Math.round(sleepMs / 1_000)}s ` +
          `(campaign delay budget left ${Math.round(overloadDelayBudgetMs / 1_000)}s)\n`,
      )
      await Bun.sleep(sleepMs)
      overloadDelayBudgetMs -= sleepMs
      pressure = loadPressure()
      sleepMs = nextOverloadDelayMs({
        pressure,
        budgetLeftMs: overloadDelayBudgetMs,
        pollMs: START_DELAY_POLL_MS,
        thresholdPressure: START_DELAY_PRESSURE,
      })
    }
  }
  return loadPressure() > 1 ? 1 : workerConcurrency()
}

const executeChunks = async (input: {
  readonly chunks: readonly CachedChunk[]
  readonly opts: RunnerOptions
  readonly runRoot: string
  readonly before: GitSnapshot
  readonly testTimeoutMs: number
  readonly registry: ShardProcessRegistry
  readonly journal: TimingJournal
}): Promise<readonly string[]> => {
  const totalChunks = input.chunks.length
  const scanReachSinks = new Map<number, string>()
  const misses: CachedChunk[] = []
  for (const cached of input.chunks) {
    if (input.opts.cacheMode === "off") {
      process.stdout.write(
        `[test:shards] CACHE OFF chunk=${cached.chunk.index}/${totalChunks} reason=cache-off\n`,
      )
      misses.push(cached)
      continue
    }
    const lookup = loadSuccessfulTestShardReceipt({
      path: cached.cachePath,
      expected: cached.identity,
      expectedTestTimeoutMs: input.testTimeoutMs,
    })
    if (lookup.kind === "miss") {
      process.stdout.write(
        `[test:shards] CACHE MISS chunk=${cached.chunk.index}/${totalChunks} reason=${lookup.reason}\n`,
      )
      misses.push(cached)
      continue
    }
    materializeCachedJunit(input.opts, cached.chunk.index, lookup.receipt)
    // A cache HIT must restore the scheduling evidence the executed run
    // produced, or the speed budget sees a green shard with no timings and
    // fails forever with no way to repair it. The sample keeps the RECEIPT's
    // creation time, never `now`: a replayed measurement ages out exactly like
    // the one it replays.
    input.journal.record(
      receiptTimingSamples(lookup.receipt.timingObservations),
      lookup.receipt.createdAtMs,
    )
    scanReachSinks.set(
      cached.chunk.index,
      materializeCachedScanReachSink(input.runRoot, lookup.receipt),
    )
    process.stdout.write(
      `[test:shards] CACHE HIT chunk=${cached.chunk.index}/${totalChunks} ` +
        `receipt=${lookup.receipt.receiptSha256.slice(0, 12)}\n`,
    )
  }

  // Longest predicted chunks start first (online LPT); the scheduler overlaps
  // only resource-compatible classes and re-measures the host before every
  // start. The first failure cancels every peer group and reaps the schedule
  // before the primary error propagates.
  const queue = [...misses].sort(
    (left, right) =>
      right.chunk.predictedMs - left.chunk.predictedMs || left.chunk.index - right.chunk.index,
  )
  const completed = await runResourceAwareSchedule<{ index: number; sink: string }>({
    tasks: queue.map((cached) => ({
      key: cached.chunk.index,
      resourceClass: cached.chunk.resourceClass,
      run: async () => {
        const result = await runShard(
          cached.chunk,
          totalChunks,
          input.opts,
          input.runRoot,
          input.testTimeoutMs,
          input.registry,
          cached.intraParallel,
        )
        const completedShard = {
          plan: cached.chunk,
          totalChunks,
          result,
          snapshot: await gitSnapshot(),
          suite: input.opts.suite,
          // What the scheduler is allowed to overlap, derived from the same
          // memory budget the dispatcher uses — not a new field threaded
          // through three layers to say something already decided.
          workerParallel: chooseShardConcurrency({
            totalBytes: totalmem(),
            availableBytes: freemem(),
          }),
          intraParallel: cached.intraParallel,
          testTimeoutMs: input.testTimeoutMs,
        }
        const sink = validateCompletedShard(input.before, completedShard)
        cacheSuccessfulShard(cached, result, input.opts, input.journal, input.testTimeoutMs)
        return { index: cached.chunk.index, sink }
      },
    })),
    overlap: (left, right) =>
      resourceClassesOverlap(left as TestResourceClass, right as TestResourceClass),
    desiredConcurrency: measuredConcurrency,
    cancelAll: () => input.registry.cancelAll(),
    onReapTimeout: (pending) =>
      process.stderr.write(
        `[test:shards] WARN schedule reap timed out with ${pending} task(s) outstanding\n`,
      ),
  })
  for (const shard of completed.values()) scanReachSinks.set(shard.index, shard.sink)

  if (scanReachSinks.size !== input.chunks.length) {
    throw new Error(`[test:shards] cache/execution coverage incomplete: ${scanReachSinks.size}`)
  }
  return input.chunks.map(({ chunk }) => {
    const sink = scanReachSinks.get(chunk.index)
    if (sink === undefined) throw new Error(`[test:shards] missing sink for chunk ${chunk.index}`)
    return sink
  })
}

const executeChunksWithSourcePostflight = async (
  input: Parameters<typeof executeChunks>[0],
): Promise<readonly string[]> => {
  let receipts: readonly string[] | undefined
  let executionError: unknown
  try {
    receipts = await executeChunks(input)
  } catch (error) {
    executionError = error
  }
  let sourceJsError: unknown
  try {
    await assertNoNewSourceJs()
  } catch (error) {
    sourceJsError = error
    // A chunk that emitted executable source beside `.ts` did not satisfy the
    // isolation contract. Do not let receipts written before this global
    // postflight turn the next campaign green without execution.
    for (const chunk of input.chunks) rmSync(chunk.cachePath, { force: true })
  }
  if (executionError !== undefined && sourceJsError !== undefined) {
    throw new AggregateError(
      [executionError, sourceJsError],
      "[test:shards] shard execution and source-JS postflight both failed",
    )
  }
  if (executionError !== undefined) throw executionError
  if (sourceJsError !== undefined) throw sourceJsError
  if (receipts === undefined) throw new Error("[test:shards] missing execution receipts")
  return receipts
}

/**
 * Read at most `windowBytes` from the END of a file.
 *
 * `readFileSync(spool, "utf8")` over a multi-hundred-megabyte spool is the
 * runner spending its own RSS on the output of the thing it is trying to bound.
 */
const readSpoolTail = (path: string, windowBytes: number): string => {
  const size = statSync(path).size
  const window = spoolTailWindow(size, windowBytes)
  if (window.length === 0) return ""
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.allocUnsafe(window.length)
    readSync(fd, buffer, 0, window.length, window.start)
    return buffer.toString("utf8")
  } finally {
    closeSync(fd)
  }
}

const digestFiles = (files: readonly string[]): string =>
  new Bun.CryptoHasher("sha256").update(files.join("\0")).digest("hex")

const tierSelection = (
  relativeFiles: readonly string[],
  tier: RunnerOptions["tier"],
): { readonly files: readonly string[]; readonly policySha256?: string } => {
  if (tier === undefined) return { files: relativeFiles }
  const overrides = loadPolicyOverrides(TEST_POLICY_OVERRIDES).overrides
  const policies = resolveTestPopulation(relativeFiles, overrides)
  const selected = selectTestPoliciesForTier(policies, tier)
  if (selected.length === 0) {
    throw new Error(`[test:shards] INVALID — tier=${tier} selected zero files`)
  }
  return {
    files: selected.map(({ id }) => id),
    policySha256: policyDigest(policies),
  }
}

const emitDiscovery = (opts: RunnerOptions): void => {
  const inventory = discoverInventory(REPO_ROOT)
  const selected = inventory.suites[opts.suite]
  const tiered = tierSelection(selected.files, opts.tier)
  const selectedPopulation =
    opts.tier === undefined
      ? selected
      : {
          ...selected,
          name: `${selected.name}:${opts.tier}`,
          files: tiered.files,
          digestSha256: digestFiles(tiered.files),
          policySha256: tiered.policySha256,
        }
  process.stdout.write(
    `${JSON.stringify({ schema: "quanta.shard-discovery.v1", selected: selectedPopulation, inventory }, null, 2)}\n`,
  )
}

const cacheSuiteName = (opts: RunnerOptions): string =>
  opts.tier === undefined ? opts.suite : `${opts.suite}:${opts.tier}`

/**
 * Discover the suite and hand the sequence to the extracted selector.
 *
 * The floors themselves live in `test-shard-selection.ts` because this file ends
 * in a top-level `await main()` and cannot be imported by a test — so the only
 * evidence for them was a source read. They are executable there.
 */
const selectManifest = (opts: RunnerOptions): ShardSelection =>
  selectShardManifest({
    suite: opts.suite,
    tier: opts.tier,
    // ABSOLUTE, exactly as before: the planner buckets on these and
    // re-relativises them itself through `membershipFile`.
    discovered: [...discoverSuiteFiles(REPO_ROOT, opts.suite)],
    idOf: (file) => relative(REPO_ROOT, file),
    suiteFloor: SUITE_FLOORS[opts.suite],
    tierFloors: loadTierPopulationFloors(),
    selectForTier: (files, tier) => tierSelection(files, tier as RunnerOptions["tier"]),
  })

/**
 * One cache identity per chunk, decided once so the receipt describes the
 * schedule the run will actually use.
 *
 * Extracted from `main()` rather than inlined: the identity is where four
 * separate correctness properties meet — the stable timeout policy, the input
 * scope, the tool scope and the intra-worker width — and burying it in an
 * already-long entrypoint is how the load-derived timeout ended up hashed into
 * it unnoticed.
 */
/**
 * The resource registry, or nothing, never a dead campaign.
 *
 * The registry is mid-migration (module at schema v2, JSON still v1). A registry
 * that will not parse must mean "nothing is certified" — which keeps every chunk
 * on the whole-tree fail-safe identity — rather than stopping the run.
 */
const loadResourceCertificationsOrWarn = (): ReturnType<
  typeof loadTestResourceCertificationsSafe
>["certifications"] => {
  const load = loadTestResourceCertificationsSafe(
    join(REPO_ROOT, "tools", "dev", "test-resource-certifications.json"),
  )
  if (load.error !== undefined) {
    process.stderr.write(
      `[test:shards] WARN resource certifications unreadable (${load.error}); ` +
        "every chunk keeps the whole-tree cache identity\n",
    )
  }
  return load.certifications
}

const buildCachedChunks = (input: {
  readonly chunks: readonly TestChunk[]
  readonly opts: RunnerOptions
  readonly treeSha256: string
  readonly manifestDigest: string
  readonly runtimeSha256: string
  readonly envSha256: string
  readonly timeoutPolicyDigest: string
  readonly resourceCertifications: Parameters<
    typeof resolveChunkCacheScope
  >[0]["resourceCertifications"]
  readonly cpuCount: number
  readonly concurrency: number
}): readonly CachedChunk[] =>
  input.chunks.map((chunk) => {
    const filesSha256 = shardFilesSha256(REPO_ROOT, chunk.files)
    const intraParallel = chooseIntraWorkerParallelism({
      resourceClass: chunk.resourceClass,
      cpuCount: input.cpuCount,
      workers: input.concurrency,
      pressure: loadPressure(),
    })
    // Certified only when EVERY file is both resource-certified and
    // declared-input certified. The registry currently holds zero
    // certifications, so this resolves to `whole-tree` for every chunk and the
    // cache behaves exactly as it does today — the narrowing is available and
    // proven by test, not yet exercised in production.
    const scope = resolveChunkCacheScope({
      repoRoot: REPO_ROOT,
      ids: chunk.files.map((file) => relative(REPO_ROOT, file)),
      resourceCertifications: input.resourceCertifications,
    })
    const identity: TestShardCacheIdentity = {
      scopeKind: scope.kind,
      treeSha256: input.treeSha256,
      suite: cacheSuiteName(input.opts),
      manifestSha256: input.manifestDigest,
      shardIndex: chunk.index,
      shardFileCount: chunk.files.length,
      shardFilesSha256: filesSha256,
      runtimeSha256: input.runtimeSha256,
      toolScopeSha256: scope.toolScopeSha256,
      testEnvSha256: input.envSha256,
      junit: true,
      intraParallel,
      executionPolicySha256: executionPolicyDigest({
        version: "v2",
        runnerIdentity: `bun-${Bun.version}-${process.platform}-${process.arch}`,
        intraParallel,
        timeoutPolicyDigest: input.timeoutPolicyDigest,
        isolationPolicyDigest: new Bun.CryptoHasher("sha256")
          .update(chunk.resourceClass)
          .digest("hex"),
        environmentDigest: input.envSha256,
        cacheMode: input.opts.cacheMode,
      }),
      timeoutPolicySha256: input.timeoutPolicyDigest,
      inputScopeSha256: scope.inputScopeSha256,
      producerReceiptsSha256: scope.producerReceiptsSha256,
    }
    return {
      chunk,
      intraParallel,
      cachePath: chunkCachePath(identity),
      identity,
      scopeReason: scope.reason,
    }
  })

const main = async (): Promise<void> => {
  const opts = parseOptions(process.argv.slice(2))
  if (opts.discoverOnly) {
    emitDiscovery(opts)
    return
  }
  // A campaign wrapper (verification-campaign.ts) may already own the
  // repository lane for this whole verification run. A live ancestor-owned
  // token means "do not reacquire" — reacquiring would deadlock against the
  // wrapper's own lease. A token that fails validation fails CLOSED.
  const inheritedLease = await inheritedTestShardLeaseState({
    env: process.env,
    // The handshake, not just the shape: ask the owner's own listener whether
    // it issued this token. Without this the check was "any 64 hex characters
    // beside a live ancestor pid", which a child can satisfy by inventing one.
    confirmToken: async (token) => {
      const raw = process.env[VERIFICATION_LEASE_OWNER_IDENTITY_ENV]
      if (raw === undefined || raw === "") return false
      const identity = normalizeRepositoryIdentity(raw)
      return await confirmLeaseToken(testShardLeasePort(identity), identity, token)
    },
  })
  if (inheritedLease === "invalid") {
    throw new Error(
      "[test:shards] invalid inherited verification lease; refusing to bypass serialization",
    )
  }
  let lease: TestShardLease | undefined
  let leaseIdentity: string | undefined
  if (inheritedLease === "valid") {
    process.stdout.write("[test:shards] LEASE inherited scope=whole-campaign\n")
  } else {
    const [remote, commonDir] = await Promise.all([
      capture(["git", "remote", "get-url", "origin"]),
      capture(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ])
    const identity = selectRepositoryLeaseIdentity({
      repositoryId: readCommittedRepositoryLeaseId(REPO_ROOT),
      remote,
      commonDir,
      cwd: process.cwd(),
    })
    // NORMALISED, like the lease itself: `acquireTestShardLease` runs its
    // identity through `normalizeRepositoryIdentity` before hashing a port,
    // so a quarantine written under the raw string is compared against a
    // different key and never blocks. A behavioural acquisition test caught
    // that; the source-shaped wiring assertions did not.
    leaseIdentity = normalizeRepositoryIdentity(identity)
    lease = await acquireTestShardLease({
      identity,
      quarantinePath: QUARANTINE_PATH,
      onQuarantineWait: (reason) => process.stdout.write(`[test:shards] WAIT ${reason}\n`),
      onWait: (port, elapsedMs) =>
        process.stdout.write(
          `[test:shards] WAIT repository lease port=${port} elapsed=${Math.round(elapsedMs / 1_000)}s; ` +
            "another checkout owns the full-suite lane\n",
        ),
    })
    process.stdout.write(`[test:shards] LEASE acquired port=${lease.port} scope=shards-only\n`)
  }
  const runRoot = mkdtempSync(join(tmpdir(), "quanta-test-shards-"))
  const registry = new ShardProcessRegistry()
  // SIGINT/SIGTERM must not orphan the worker trees: cancel every group,
  // wait for descendants to drain, only then delete the run root and release
  // the lease. Without a handler the runner dies instantly and leaves live
  // workers overlapping the next campaign.
  let terminating = false
  const onTerminationSignal = (signal: NodeJS.Signals): void => {
    if (terminating) return
    terminating = true
    void terminateCampaignOnSignal({
      registry,
      runRoot,
      signal,
      releaseLease: () => lease?.release(),
      log: (line) => process.stderr.write(line),
    }).then((code) => process.exit(code))
  }
  process.on("SIGINT", () => onTerminationSignal("SIGINT"))
  process.on("SIGTERM", () => onTerminationSignal("SIGTERM"))
  try {
    // A red or interrupted run must never leave a previous green receipt looking
    // current. The repository lease makes this deletion race-free across clones.
    if (opts.suite === "full") rmSync(SCAN_REACH_RECEIPT, { force: true })
    await preflightSourceJs()
    const before = await gitSnapshot()
    if (before.status !== "") {
      throw new Error(
        "[test:shards] INVALID — authoritative receipts require a clean checkout. Commit or stash changes first.",
      )
    }
    const { discovered: discoveredManifest, manifest, tiered } = selectManifest(opts)
    const manifestDigest = manifestSha256(manifest)
    const treeSha256 = trackedTreeSha256(REPO_ROOT)
    // Fold anything an interrupted campaign already measured back in, before
    // this campaign reads the store for planning.
    recoverAbandonedTimingJournals(TIMING_STORE)
    const timings = loadTestTimings(TIMING_STORE)
    const chunks = planTestChunks(manifest, {
      predictMs: (file) => timings.get(relative(REPO_ROOT, file)),
      membershipFile: (file) => relative(REPO_ROOT, file),
    })
    if (opts.junitOut !== undefined) {
      prepareJunit(
        opts.junitOut,
        chunks.map(({ index }) => index),
      )
    }
    const concurrency = await workerConcurrency()
    const cpuCount = availableParallelism()
    const loadAverage1m = loadavg()[0] ?? 0
    const testTimeoutMs = chooseShardTestTimeoutMs({ loadAverage1m, cpuCount })
    const nonPureFiles = chunks
      .filter(({ resourceClass }) => resourceClass !== "pure")
      .reduce((count, chunk) => count + chunk.files.length, 0)
    process.stdout.write(
      `[test:shards] frozen head=${before.head} suite=${opts.suite} tier=${opts.tier ?? "legacy"} dirty=no ` +
        `discovered_files=${discoveredManifest.length} manifest_files=${manifest.length} ` +
        `manifest_sha256=${manifestDigest} ` +
        `policy_sha256=${tiered.policySha256 ?? "legacy"} ` +
        `chunks=${chunks.length} timed_files=${timings.size} workers=${concurrency} ` +
        `test_timeout_ms=${testTimeoutMs} load_1m=${loadAverage1m.toFixed(2)} cpus=${cpuCount} ` +
        `non_pure_files=${nonPureFiles}\n`,
    )

    const runtimeSha256 = testRuntimeSha256()
    // The STABLE policy base, not the load-derived instance value. A 1-minute
    // load average moved the 120/240/300s timeout, and that number was hashed
    // into the execution-policy digest — so identical code missed every chunk
    // purely because the box got busier. The executed timeout still follows load.
    const timeoutPolicy = currentTimeoutPolicy()
    const envSha256 = testEnvironmentSha256(process.env, timeoutPolicy.baseMs, REPO_ROOT)
    const timeoutPolicyDigest = timeoutPolicySha256(timeoutPolicy)
    // SAFE loader: the resource registry is mid-migration (module at schema v2,
    // JSON still v1), and a registry that will not parse must mean "nothing is
    // certified", never a dead campaign.
    const resourceCertifications = loadResourceCertificationsOrWarn()
    const journal = openTimingJournal({ storePath: TIMING_STORE })
    // One decision per chunk, made here so the receipt's identity describes the
    // schedule the run will actually use. `workers` is the concurrency the host
    // measured at campaign start; the per-start measurement can still drop the
    // WORKER count later, but a chunk's own file concurrency stays fixed.
    const cachedChunks = buildCachedChunks({
      chunks,
      opts,
      treeSha256,
      manifestDigest,
      runtimeSha256,
      envSha256,
      timeoutPolicyDigest,
      resourceCertifications,
      cpuCount,
      concurrency,
    })

    const scanReachSinks = await executeChunksWithSourcePostflight({
      chunks: cachedChunks,
      opts,
      runRoot,
      before,
      testTimeoutMs,
      registry,
      journal,
    })
    // THE ONE store write of the campaign, whatever the chunk count. It used to
    // be a whole-store read-sort-rewrite per completed chunk — up to 44 per full
    // run.
    const committed = journal.commit()
    process.stdout.write(
      `[test:shards] timing store committed files=${committed.files} ` +
        `writes=${committed.storeWrites} recovered_journals=${committed.recoveredJournals}\n`,
    )

    const after = await gitSnapshot()
    if (!sameSnapshot(before, after)) {
      throw new Error(
        `[test:shards] INVALID — checkout changed during run (start=${before.head}, end=${after.head}). ` +
          "Re-run against one stable snapshot; this receipt cannot describe a single source state.",
      )
    }
    writeScanReachReceipt({
      head: before.head,
      suite: opts.suite,
      tier: opts.tier,
      manifest,
      manifestSha256: manifestDigest,
      sinks: scanReachSinks,
    })
    if (opts.junitOut !== undefined) {
      mergeJunit(
        opts.junitOut,
        chunks.map(({ index }) => index),
      )
    }
    process.stdout.write(
      `[test:shards] PASS suite=${opts.suite} chunks=${chunks.length}/${chunks.length} ` +
        `manifest_files=${manifest.length} head=${before.head}\n`,
    )
  } finally {
    // Bounded GC on EVERY exit, green or red. It used to run only after total
    // success, so a repeatedly-red branch accumulated expired payloads forever,
    // and it swept the bare `full` directory while tier caches are written to
    // `full:pr` / `full:nightly` — measured on this checkout, the superseded v2
    // root alone held 307 receipts / 127 MiB, all expired. TTL is the only
    // criterion, so a sibling worktree resuming from its own receipts survives.
    sweepExpiredShardCaches()
    // Drain before release: the run root is deleted only once every worker
    // group is confirmed empty, and the lease is released only after that —
    // a surviving descendant must never overlap the next campaign.
    // A campaign that could not account for its own descendants has not
    // finished: the lane is about to be released to the next contender while
    // processes from this one may still hold ports, worktrees and HOME. The
    // PASS line above is not the verdict — the exit code is.
    const drain = await drainCampaign({
      registry,
      runRoot,
      log: (line) => process.stderr.write(line),
    })
    if (!drain.drained) {
      process.exitCode = 1
      process.stderr.write(
        `[test:shards] INVALID — worker group(s) unaccounted for: ${drain.survivors.join(", ")}; ` +
          "refusing to bless this run\n",
      )
      // The verdict was already honest; the HANDOFF was not. Releasing here
      // gave the next contender a lane whose ports, HOME and worktrees are
      // still held by processes this campaign could not account for. Written
      // BEFORE the release, because the kernel frees the port the instant this
      // process exits.
      if (leaseIdentity !== undefined && drain.groups.length > 0) {
        quarantineLane({
          path: QUARANTINE_PATH,
          repositoryId: leaseIdentity,
          groups: drain.groups,
          log: (line) => process.stderr.write(line),
        })
      }
    }
    lease?.release()
  }
}

await main()
