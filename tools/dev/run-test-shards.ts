import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism, freemem, homedir, loadavg, tmpdir, totalmem } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { sampleTreeRssBytes } from "./shard-rss"
import {
  loadPolicyOverrides,
  policyDigest,
  resolveTestPopulation,
  selectTestPoliciesForTier,
} from "./test-policy"
import {
  discoverInventory,
  discoverSuiteFiles,
  SUITE_FLOORS,
  type SuiteName,
} from "./test-shard-discovery"
import {
  acquireTestShardLease,
  inheritedTestShardLeaseState,
  readCommittedRepositoryLeaseId,
  selectRepositoryLeaseIdentity,
  type TestShardLease,
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
  watchdogAction,
} from "./test-shard-plan"
import {
  loadSuccessfulTestShardReceipt,
  mergeScanReachSinks,
  type SuccessfulTestShardReceipt,
  shardFilesSha256,
  type TestShardCacheIdentity,
  testEnvironmentSha256,
  testShardCacheIdentitySha256,
  testToolchainSha256,
  trackedTreeSha256,
  writeScanReachReceiptAtomic,
  writeSuccessfulTestShardReceiptAtomic,
} from "./test-shard-receipt"
import {
  harvestChunkTimingObservations,
  loadTestTimings,
  mergeTestTimingObservations,
} from "./test-shard-timings"
import { ADMISSION_DEADLINE_ENV } from "./verification-admission"
import { executionPolicyDigest } from "./verification-execution-policy"
import { chunkInputScopeSha256 } from "./verification-input-scope"
import { sharedVerificationCacheRoot } from "./verification-receipt"
import { type UserLibraryDecision, userLibraryDecision } from "./worker-home"

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
const SHARD_CACHE_ROOT = join(SHARED_CACHE_ROOT, "test-shards", "v3")
const TIMING_STORE = join(SHARED_CACHE_ROOT, "test-timings-v2.json")
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
  readonly manifestSha256: string
  readonly sinks: readonly string[]
}): void => {
  // Only full covers every enrolled scan id. A unit receipt is internally
  // successful but incomplete and would make the closed-universe consumer
  // report src/integration ids as stale.
  if (input.suite !== "full") return
  writeScanReachReceiptAtomic({
    path: SCAN_REACH_RECEIPT,
    head: input.head,
    suite: input.suite,
    manifestSha256: input.manifestSha256,
    sinks: input.sinks,
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
  join(SHARD_CACHE_ROOT, identity.suite, `chunk-${testShardCacheIdentitySha256(identity)}.json`)

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
 * TTL-based garbage collection. The cache directory is SHARED across
 * worktrees, so "not part of MY current plan" is not evidence of staleness —
 * a sibling checkout at another HEAD may still be resuming from its receipts.
 * Only receipts past their own expiry (or unreadable) are dropped.
 */
const pruneStaleChunkReceipts = (suite: SuiteName, nowMs = Date.now()): void => {
  const dir = join(SHARD_CACHE_ROOT, suite)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    let expired = true
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { expiresAtMs?: unknown }
      expired = !(
        Number.isSafeInteger(parsed.expiresAtMs) && (parsed.expiresAtMs as number) > nowMs
      )
    } catch {
      expired = true
    }
    if (expired) rmSync(path, { force: true })
  }
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
): UserLibraryDecision | "unavailable" => {
  const decision = userLibraryDecision(resourceClass, process.env)
  if (decision !== "lend") return decision
  try {
    const real = join(homedir(), "Library")
    if (!existsSync(real)) return "unavailable"
    symlinkSync(real, join(workerHome, "Library"))
    return "lend"
  } catch {
    // Already linked, or a platform without this convention.
    return "unavailable"
  }
}

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
      const action = watchdogAction({
        spoolBytes,
        lastSpoolBytes,
        idleMs,
        inactivityTimeoutMs: SHARD_INACTIVITY_TIMEOUT_MS,
        alreadyKilling: timedOut,
      })
      if (action === "progressed") {
        lastSpoolBytes = spoolBytes
        lastProgressAt = Date.now()
        return
      }
      if (action !== "kill") return
      timedOut = true
      // Say what it was doing. A chunk holds ~100 files, and "idle=600000ms"
      // over all of them is not a lead; the last thing the worker wrote is.
      process.stderr.write(
        `[test:shards] TIMEOUT chunk=${shard} idle=${idleMs}ms; ` +
          `killing worker process tree.\nProcess group (pgid pid ppid stat %cpu elapsed cmd):\n` +
          `${describeProcessGroup(handle.pid)}\nLast output:\n` +
          `${spoolTail(readFileSync(spoolPath, "utf8"), WATCHDOG_TAIL_LINES)}\n`,
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
    const output = readFileSync(spoolPath, "utf8")
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
}

interface CachedChunk {
  readonly chunk: TestChunk
  readonly identity: TestShardCacheIdentity
  readonly cachePath: string
  /** Decided once, at plan time, so the receipt's identity and the run agree. */
  readonly intraParallel: number
}

const validateCompletedShard = (before: GitSnapshot, completed: CompletedShard): string => {
  const { plan, totalChunks, result, snapshot } = completed
  if (!sameSnapshot(before, snapshot)) {
    throw new Error(
      `[test:shards] INVALID — checkout changed after chunk ${plan.index}/${totalChunks} ` +
        `(start=${before.head}, current=${snapshot.head}). Aborting remaining shards.`,
    )
  }
  if (result.code === 0 && !result.timedOut && result.executedFiles === plan.files.length) {
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
  const discovery =
    result.executedFiles === undefined ? "missing" : `${result.executedFiles}/${plan.files.length}`
  throw new Error(
    `[test:shards] FAILED chunk=${plan.index}/${totalChunks} exit=${result.code} ` +
      `timeout=${result.timedOut ? "yes" : "no"} discovery=${discovery}; ` +
      "aborting remaining shards",
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

const cacheSuccessfulShard = (
  cached: CachedChunk,
  result: ShardRunResult,
  opts: RunnerOptions,
): void => {
  if (result.executedFiles === undefined) {
    throw new Error(`[test:shards] chunk ${cached.chunk.index} has no executed-file receipt`)
  }
  const junitXml = readFileSync(result.junitPath, "utf8")
  junitBody(junitXml, cached.chunk.index)
  if (opts.cacheMode === "off") return
  writeSuccessfulTestShardReceiptAtomic({
    path: cached.cachePath,
    identity: { ...cached.identity, junit: true },
    executedFiles: result.executedFiles,
    scanReachRecords: mergeScanReachSinks([result.scanReachSink]),
    junitXml,
  })
}

/** Every green chunk feeds measured per-file wall time back to the planner. */
const harvestTimings = (cached: CachedChunk, result: ShardRunResult): void => {
  try {
    const junitXml = readFileSync(result.junitPath, "utf8")
    // Bun writes the JUnit `file` attribute RELATIVE to the worker's cwd (the
    // repo root) even when the command line carried absolute paths, so the
    // harvest must look suites up by the same relative key (measured on 1.3.14).
    const relFiles = cached.chunk.files.map((file) => relative(REPO_ROOT, file))
    const observations = harvestChunkTimingObservations(junitXml, relFiles, result.elapsedMs, {
      runnerClass: cached.chunk.resourceClass,
      policyDigest: cached.identity.executionPolicySha256,
      intraParallel: cached.intraParallel,
      loadPerCore: Math.max(0, (loadavg()[0] ?? 0) / availableParallelism()),
    })
    mergeTestTimingObservations(TIMING_STORE, observations)
  } catch (error) {
    // Timing is a scheduler hint, never a verdict input; a harvest failure is
    // reported and the campaign continues.
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[test:shards] WARN timing harvest failed for chunk ${cached.chunk.index}: ${message}\n`,
    )
  }
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
    })
    if (lookup.kind === "miss") {
      process.stdout.write(
        `[test:shards] CACHE MISS chunk=${cached.chunk.index}/${totalChunks} reason=${lookup.reason}\n`,
      )
      misses.push(cached)
      continue
    }
    materializeCachedJunit(input.opts, cached.chunk.index, lookup.receipt)
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
        }
        const sink = validateCompletedShard(input.before, completedShard)
        cacheSuccessfulShard(cached, result, input.opts)
        harvestTimings(cached, result)
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
  const inheritedLease = inheritedTestShardLeaseState(process.env)
  if (inheritedLease === "invalid") {
    throw new Error(
      "[test:shards] invalid inherited verification lease; refusing to bypass serialization",
    )
  }
  let lease: TestShardLease | undefined
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
    lease = await acquireTestShardLease({
      identity,
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
    const discoveredManifest = [...discoverSuiteFiles(REPO_ROOT, opts.suite)]
    const tiered = tierSelection(
      discoveredManifest.map((file) => relative(REPO_ROOT, file)),
      opts.tier,
    )
    const selectedIds = new Set(tiered.files)
    const manifest = discoveredManifest.filter((file) => selectedIds.has(relative(REPO_ROOT, file)))
    // A FLOOR, not a printout. `manifest_files=N` was reported and compared to
    // nothing: a suite root that still exists but stops yielding test files —
    // a naming change, a bad merge, a directory renamed under a dot prefix —
    // shrinks the corpus silently and the campaign still prints PASS. This is
    // the same argument scan-reach-baseline.json makes for scanning guards,
    // applied to the suite the whole verdict rests on.
    const floor = SUITE_FLOORS[opts.suite]
    if (manifest.length < floor) {
      throw new Error(
        `[test:shards] INVALID — suite=${opts.suite} discovered ${manifest.length} test files, ` +
          `below the pinned floor of ${floor}. The corpus shrank under the runner; a green over ` +
          "it would describe a smaller universe than the one this gate claims.",
      )
    }
    const manifestDigest = manifestSha256(manifest)
    const treeSha256 = trackedTreeSha256(REPO_ROOT)
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
        `manifest_files=${manifest.length} manifest_sha256=${manifestDigest} ` +
        `policy_sha256=${tiered.policySha256 ?? "legacy"} ` +
        `chunks=${chunks.length} timed_files=${timings.size} workers=${concurrency} ` +
        `test_timeout_ms=${testTimeoutMs} load_1m=${loadAverage1m.toFixed(2)} cpus=${cpuCount} ` +
        `non_pure_files=${nonPureFiles}\n`,
    )

    const toolchainSha256 = testToolchainSha256()
    const envSha256 = testEnvironmentSha256(process.env, testTimeoutMs, REPO_ROOT)
    // One decision per chunk, made here so the receipt's identity describes the
    // schedule the run will actually use. `workers` is the concurrency the host
    // measured at campaign start; the per-start measurement can still drop the
    // WORKER count later, but a chunk's own file concurrency stays fixed.
    const cachedChunks: readonly CachedChunk[] = chunks.map((chunk) => {
      const filesSha256 = shardFilesSha256(REPO_ROOT, chunk.files)
      const intraParallel = chooseIntraWorkerParallelism({
        resourceClass: chunk.resourceClass,
        cpuCount,
        workers: concurrency,
        pressure: loadPressure(),
      })
      const identity: TestShardCacheIdentity = {
        treeSha256,
        suite: cacheSuiteName(opts),
        manifestSha256: manifestDigest,
        shardIndex: chunk.index,
        shardFileCount: chunk.files.length,
        shardFilesSha256: filesSha256,
        toolchainSha256,
        testEnvSha256: envSha256,
        junit: true,
        intraParallel,
        executionPolicySha256: executionPolicyDigest({
          version: "v2",
          runnerIdentity: `bun-${Bun.version}-${process.platform}-${process.arch}`,
          intraParallel,
          timeoutPolicyDigest: new Bun.CryptoHasher("sha256")
            .update(String(testTimeoutMs))
            .digest("hex"),
          isolationPolicyDigest: new Bun.CryptoHasher("sha256")
            .update(chunk.resourceClass)
            .digest("hex"),
          environmentDigest: envSha256,
          cacheMode: opts.cacheMode,
        }),
        inputScopeSha256: chunkInputScopeSha256(
          REPO_ROOT,
          chunk.files.map((file) => relative(REPO_ROOT, file)),
        ),
      }
      return {
        chunk,
        intraParallel,
        cachePath: chunkCachePath(identity),
        identity,
      }
    })

    const scanReachSinks = await executeChunksWithSourcePostflight({
      chunks: cachedChunks,
      opts,
      runRoot,
      before,
      testTimeoutMs,
      registry,
    })

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
      manifestSha256: manifestDigest,
      sinks: scanReachSinks,
    })
    if (opts.junitOut !== undefined) {
      mergeJunit(
        opts.junitOut,
        chunks.map(({ index }) => index),
      )
    }
    pruneStaleChunkReceipts(opts.suite)
    process.stdout.write(
      `[test:shards] PASS suite=${opts.suite} chunks=${chunks.length}/${chunks.length} ` +
        `manifest_files=${manifest.length} head=${before.head}\n`,
    )
  } finally {
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
    }
    lease?.release()
  }
}

await main()
