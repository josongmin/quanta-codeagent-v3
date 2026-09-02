import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism, freemem, loadavg, tmpdir, totalmem } from "node:os"
import { join, relative, resolve } from "node:path"
import { expandTestFiles } from "./sandboxed-test"
import {
  acquireTestShardLease,
  readCommittedRepositoryLeaseId,
  selectRepositoryLeaseIdentity,
} from "./test-shard-lease"
import {
  chooseShardConcurrency,
  chooseShardTestTimeoutMs,
  createTestShardPlan,
  parseExecutedFileCount,
  type TestShardPlan,
} from "./test-shard-plan"
import {
  loadSuccessfulTestShardReceipt,
  mergeScanReachSinks,
  type SuccessfulTestShardReceipt,
  shardFilesSha256,
  type TestShardCacheIdentity,
  testEnvironmentSha256,
  testToolchainSha256,
  writeScanReachReceiptAtomic,
  writeSuccessfulTestShardReceiptAtomic,
} from "./test-shard-receipt"

/**
 * Authoritative local full-suite runner.
 *
 * Bun's one-process full run exhausts JSC on this repository. The worker
 * script remains available as `test:shard`, but this runner owns the full
 * verdict: it discovers the manifest exactly once, gives each worker explicit
 * file paths, overlaps at most two resource-isolated workers, records every
 * exit, and refuses to bless a result if another session changed the checkout.
 */

const SHARD_COUNT = 8
const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const SCAN_REACH_RECEIPT = join(REPO_ROOT, ".cache", "scan-reach-receipt.json")
const SHARD_CACHE_ROOT = join(REPO_ROOT, ".cache", "test-shards", "v1")
// The shard corpus contains cold-path source scans and real CLI integration
// rails. A normal shard can exceed twelve minutes while continuously reporting
// completed tests on a contended host, so a total wall-clock cap discards valid
// coverage. This is instead a *progress* watchdog: a CPU-bound Bun worker that
// ignores Bun's per-test timeout eventually goes silent and is still killed,
// while an active shard retains its complete corpus verdict.
const SHARD_INACTIVITY_TIMEOUT_MS = 12 * 60_000
const SHARD_WATCHDOG_POLL_MS = 1_000
const SUITE_ROOTS = {
  full: [
    "tests/unit",
    "tests/meta",
    "tests/adversarial",
    "tests/measurement",
    "tests/integration",
    "./src/",
    "./tools/",
  ],
  core: [
    "tests/unit",
    "tests/meta",
    "tests/adversarial",
    "tests/measurement",
    "./src/",
    "./tools/",
  ],
  unit: ["tests/unit"],
  integration: ["tests/integration"],
} as const

type SuiteName = keyof typeof SUITE_ROOTS

interface RunnerOptions {
  readonly suite: SuiteName
  readonly junitOut?: string
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

const suiteOption = (arg: string): SuiteName | undefined => {
  if (!arg.startsWith("--suite=")) return undefined
  const candidate = arg.slice("--suite=".length)
  if (!(candidate in SUITE_ROOTS)) throw new Error(`unknown shard suite: ${candidate}`)
  return candidate as SuiteName
}

const junitOption = (arg: string): string | undefined => {
  if (!arg.startsWith("--junit-out=")) return undefined
  const candidate = arg.slice("--junit-out=".length)
  if (!candidate.startsWith(".cache/") || candidate.includes("..")) {
    throw new Error("--junit-out must be a safe .cache/ path")
  }
  return candidate
}

const parseOptions = (args: readonly string[]): RunnerOptions => {
  let suite: SuiteName = "full"
  let junitOut: string | undefined
  for (const arg of args) {
    if (arg === "--parallel=1") continue
    const selectedSuite = suiteOption(arg)
    if (selectedSuite !== undefined) {
      suite = selectedSuite
      continue
    }
    const selectedJunit = junitOption(arg)
    if (selectedJunit !== undefined) {
      junitOut = selectedJunit
      continue
    }
    throw new Error(`unknown shard runner argument: ${arg}`)
  }
  if (junitOut !== undefined && suite !== "unit") {
    throw new Error("JUnit shard receipts are reserved for --suite=unit")
  }
  return junitOut === undefined ? { suite } : { suite, junitOut }
}

const junitShardPath = (junitOut: string, index: number): string => `${junitOut}.shard-${index}.xml`

const shardCachePath = (suite: SuiteName, index: number): string =>
  join(SHARD_CACHE_ROOT, suite, `shard-${index}.json`)

const prepareJunit = (junitOut: string): void => {
  rmSync(junitOut, { force: true })
  for (let index = 1; index <= SHARD_COUNT; index += 1) {
    rmSync(junitShardPath(junitOut, index), { force: true })
  }
}

const junitBody = (xml: string, index: number): string => {
  const root = xml.indexOf("<testsuites")
  const open = root < 0 ? -1 : xml.indexOf(">", root)
  const close = xml.lastIndexOf("</testsuites>")
  if (root < 0 || open < 0 || close < 0 || !xml.includes("<testcase")) {
    throw new Error(`[test:shards] invalid JUnit receipt from shard ${index}/${SHARD_COUNT}`)
  }
  return xml.slice(open + 1, close).trim()
}

const mergeJunit = (junitOut: string): void => {
  const bodies: string[] = []
  for (let index = 1; index <= SHARD_COUNT; index += 1) {
    bodies.push(junitBody(readFileSync(junitShardPath(junitOut, index), "utf8"), index))
  }
  writeFileSync(
    junitOut,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test sharded">\n${bodies.join("\n")}\n</testsuites>\n`,
  )
}

const runShard = async (
  plan: TestShardPlan,
  opts: RunnerOptions,
  runRoot: string,
  testTimeoutMs: number,
): Promise<{
  readonly code: number
  readonly timedOut: boolean
  readonly executedFiles?: number
  readonly scanReachSink: string
}> => {
  const shard = `${plan.index}/${SHARD_COUNT}`
  const junitArgs =
    opts.junitOut === undefined
      ? []
      : ["--reporter=junit", `--reporter-outfile=${junitShardPath(opts.junitOut, plan.index)}`]
  process.stdout.write(
    `\n[test:shards] START shard=${shard} files=${plan.files.length} exclusive=${plan.exclusive ? "yes" : "no"}\n`,
  )
  // Native file descriptors keep the child off a JS relay/backpressure path.
  // Relaying every Bun test chunk through this process more than doubled a
  // measured full shard (375s direct versus the 720s kill boundary) and turned
  // a green worker into a runner timeout. Spool natively, then replay once so
  // the receipt still contains the complete worker output and discovery banner.
  const workerRoot = join(runRoot, `worker-${plan.index}`)
  const workerTmp = join(workerRoot, "tmp")
  const workerHome = join(workerRoot, "home")
  const quantaHome = join(workerHome, ".quanta")
  const prefsHome = join(workerRoot, "prefs-home")
  const benchResults = join(workerRoot, "bench-results")
  mkdirSync(workerTmp, { recursive: true })
  mkdirSync(quantaHome, { recursive: true })
  mkdirSync(prefsHome, { recursive: true })
  mkdirSync(benchResults, { recursive: true })
  const spoolPath = join(workerRoot, `shard-${plan.index}.log`)
  const scanReachSink = join(workerRoot, `scan-reach-${plan.index}.jsonl`)
  writeFileSync(scanReachSink, "")
  const spoolFd = openSync(spoolPath, "w")
  let closed = false
  try {
    const startedAt = performance.now()
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "test",
        ...plan.files,
        `--timeout=${testTimeoutMs}`,
        "--parallel=1",
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
        ...process.env,
        HOME: workerHome,
        TMPDIR: workerTmp,
        PWD: REPO_ROOT,
        QUANTA_HOME: quantaHome,
        QUANTA_PREFS_HOME: prefsHome,
        QUANTA_BENCH_RESULTS_DIR: benchResults,
        QUANTA_SCAN_REACH_RECORD: scanReachSink,
        QUANTA_TEST_TIMEOUT_SCALE: String(testTimeoutMs / 60_000),
      },
      stdout: spoolFd,
      stderr: spoolFd,
    })
    const progress = setInterval(() => {
      const elapsedSeconds = Math.round((performance.now() - startedAt) / 1_000)
      const spoolBytes = statSync(spoolPath).size
      process.stdout.write(
        `[test:shards] PROGRESS shard=${shard} elapsed=${elapsedSeconds}s spool_bytes=${spoolBytes}\n`,
      )
    }, 60_000)
    progress.unref()
    let timedOut = false
    let lastProgressAt = Date.now()
    let lastSpoolBytes = 0
    const timeout = setInterval(() => {
      const spoolBytes = statSync(spoolPath).size
      if (spoolBytes !== lastSpoolBytes) {
        lastSpoolBytes = spoolBytes
        lastProgressAt = Date.now()
        return
      }
      const idleMs = Date.now() - lastProgressAt
      if (idleMs < SHARD_INACTIVITY_TIMEOUT_MS) return
      timedOut = true
      process.stderr.write(
        `[test:shards] TIMEOUT shard=${shard} idle=${idleMs}ms; killing worker\n`,
      )
      proc.kill(9)
    }, SHARD_WATCHDOG_POLL_MS)
    const code = await proc.exited
    clearTimeout(timeout)
    clearInterval(progress)
    closeSync(spoolFd)
    closed = true
    const spoolBytes = statSync(spoolPath).size
    const output = readFileSync(spoolPath, "utf8")
    process.stdout.write(output)
    const executedFiles = parseExecutedFileCount(output)
    const elapsedMs = Math.round(performance.now() - startedAt)
    const usage = proc.resourceUsage()
    const maxRssBytes = usage?.maxRSS ?? 0
    process.stdout.write(
      `[test:shards] END shard=${shard} exit=${code}${timedOut ? " timeout" : ""} ` +
        `elapsed_ms=${elapsedMs} max_rss_bytes=${maxRssBytes} spool_bytes=${spoolBytes}\n`,
    )
    return executedFiles === undefined
      ? { code, timedOut, scanReachSink }
      : { code, timedOut, executedFiles, scanReachSink }
  } finally {
    if (!closed) closeSync(spoolFd)
  }
}

interface CompletedShard {
  readonly plan: TestShardPlan
  readonly result: Awaited<ReturnType<typeof runShard>>
  readonly snapshot: GitSnapshot
}

interface CachedShardPlan {
  readonly plan: TestShardPlan
  readonly identity: TestShardCacheIdentity
  readonly cachePath: string
}

const validateCompletedShard = (before: GitSnapshot, completed: CompletedShard): string => {
  const { plan, result, snapshot } = completed
  if (!sameSnapshot(before, snapshot)) {
    throw new Error(
      `[test:shards] INVALID — checkout changed after shard ${plan.index}/${SHARD_COUNT} ` +
        `(start=${before.head}, current=${snapshot.head}). Aborting remaining shards.`,
    )
  }
  if (result.code === 0 && !result.timedOut && result.executedFiles === plan.files.length) {
    return result.scanReachSink
  }
  const discovery =
    result.executedFiles === undefined ? "missing" : `${result.executedFiles}/${plan.files.length}`
  throw new Error(
    `[test:shards] FAILED shard=${plan.index}/${SHARD_COUNT} exit=${result.code} ` +
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

const materializeCachedJunit = (opts: RunnerOptions, receipt: SuccessfulTestShardReceipt): void => {
  if (opts.junitOut === undefined) return
  if (receipt.junitXml === undefined) {
    throw new Error(`[test:shards] cached shard ${receipt.shardIndex} lost its JUnit receipt`)
  }
  junitBody(receipt.junitXml, receipt.shardIndex)
  writeFileSync(junitShardPath(opts.junitOut, receipt.shardIndex), receipt.junitXml)
}

const cacheSuccessfulShard = (
  cachedPlan: CachedShardPlan,
  result: Awaited<ReturnType<typeof runShard>>,
  opts: RunnerOptions,
): void => {
  if (result.executedFiles === undefined) {
    throw new Error(`[test:shards] shard ${cachedPlan.plan.index} has no executed-file receipt`)
  }
  const junitXml =
    opts.junitOut === undefined
      ? undefined
      : readFileSync(junitShardPath(opts.junitOut, cachedPlan.plan.index), "utf8")
  if (junitXml !== undefined) junitBody(junitXml, cachedPlan.plan.index)
  writeSuccessfulTestShardReceiptAtomic({
    path: cachedPlan.cachePath,
    identity: cachedPlan.identity,
    executedFiles: result.executedFiles,
    scanReachRecords: mergeScanReachSinks([result.scanReachSink]),
    ...(junitXml === undefined ? {} : { junitXml }),
  })
}

const nextPlanBatch = (
  plans: readonly TestShardPlan[],
  cursor: number,
  concurrency: 1 | 2,
): readonly TestShardPlan[] => {
  const first = plans[cursor]
  if (first === undefined) return []
  if (first.exclusive) return [first]
  return plans.slice(cursor, cursor + concurrency).filter(({ exclusive }) => !exclusive)
}

const executePlans = async (input: {
  readonly plans: readonly CachedShardPlan[]
  readonly opts: RunnerOptions
  readonly runRoot: string
  readonly before: GitSnapshot
  readonly concurrency: 1 | 2
  readonly testTimeoutMs: number
}): Promise<readonly string[]> => {
  const scanReachSinks = new Map<number, string>()
  const misses: CachedShardPlan[] = []
  for (const cachedPlan of input.plans) {
    const lookup = loadSuccessfulTestShardReceipt({
      path: cachedPlan.cachePath,
      expected: cachedPlan.identity,
    })
    if (lookup.kind === "miss") {
      process.stdout.write(
        `[test:shards] CACHE MISS shard=${cachedPlan.plan.index}/${SHARD_COUNT} reason=${lookup.reason}\n`,
      )
      misses.push(cachedPlan)
      continue
    }
    materializeCachedJunit(input.opts, lookup.receipt)
    scanReachSinks.set(
      cachedPlan.plan.index,
      materializeCachedScanReachSink(input.runRoot, lookup.receipt),
    )
    process.stdout.write(
      `[test:shards] CACHE HIT shard=${cachedPlan.plan.index}/${SHARD_COUNT} ` +
        `receipt=${lookup.receipt.receiptSha256.slice(0, 12)}\n`,
    )
  }

  for (let cursor = 0; cursor < misses.length; ) {
    const batch = nextPlanBatch(
      misses.map(({ plan }) => plan),
      cursor,
      input.concurrency,
    )
    if (batch.length === 0) throw new Error("[test:shards] scheduler produced an empty batch")
    cursor += batch.length
    const completed = await Promise.all(
      batch.map(async (plan) => {
        const cachedPlan = misses.find((candidate) => candidate.plan.index === plan.index)
        if (cachedPlan === undefined) throw new Error("[test:shards] missing cache plan")
        const result = await runShard(plan, input.opts, input.runRoot, input.testTimeoutMs)
        const completedShard = { plan, result, snapshot: await gitSnapshot() }
        const sink = validateCompletedShard(input.before, completedShard)
        cacheSuccessfulShard(cachedPlan, result, input.opts)
        return { index: plan.index, sink }
      }),
    )
    for (const shard of completed) scanReachSinks.set(shard.index, shard.sink)
  }
  if (scanReachSinks.size !== input.plans.length) {
    throw new Error(`[test:shards] cache/execution coverage incomplete: ${scanReachSinks.size}`)
  }
  return input.plans.map(({ plan }) => {
    const sink = scanReachSinks.get(plan.index)
    if (sink === undefined) throw new Error(`[test:shards] missing sink for shard ${plan.index}`)
    return sink
  })
}

const main = async (): Promise<void> => {
  const opts = parseOptions(process.argv.slice(2))
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
  const lease = await acquireTestShardLease({
    identity,
    onWait: (port, elapsedMs) =>
      process.stdout.write(
        `[test:shards] WAIT repository lease port=${port} elapsed=${Math.round(elapsedMs / 1_000)}s; ` +
          "another checkout owns the full-suite lane\n",
      ),
  })
  process.stdout.write(`[test:shards] LEASE acquired port=${lease.port}\n`)
  const runRoot = mkdtempSync(join(tmpdir(), "quanta-test-shards-"))
  try {
    // A red or interrupted run must never leave a previous green receipt looking
    // current. The repository lease makes this deletion race-free across clones.
    if (opts.suite === "full") rmSync(SCAN_REACH_RECEIPT, { force: true })
    const before = await gitSnapshot()
    if (before.status !== "") {
      throw new Error(
        "[test:shards] INVALID — authoritative receipts require a clean checkout. Commit or stash changes first.",
      )
    }
    if (opts.junitOut !== undefined) prepareJunit(opts.junitOut)
    const manifest = expandTestFiles(
      SUITE_ROOTS[opts.suite].map((root) => resolve(REPO_ROOT, root)),
    )
    const manifestDigest = manifestSha256(manifest)
    const plans = createTestShardPlan(manifest, SHARD_COUNT)
    const concurrency = await workerConcurrency()
    const cpuCount = availableParallelism()
    const loadAverage1m = loadavg()[0] ?? 0
    const testTimeoutMs = chooseShardTestTimeoutMs({ loadAverage1m, cpuCount })
    const exclusiveFiles = plans
      .filter(({ exclusive }) => exclusive)
      .reduce((count, plan) => count + plan.files.length, 0)
    process.stdout.write(
      `[test:shards] frozen head=${before.head} suite=${opts.suite} dirty=no ` +
        `manifest_files=${manifest.length} manifest_sha256=${manifestDigest} ` +
        `workers=${concurrency} test_timeout_ms=${testTimeoutMs} ` +
        `load_1m=${loadAverage1m.toFixed(2)} cpus=${cpuCount} exclusive_files=${exclusiveFiles}\n`,
    )

    const toolchainSha256 = testToolchainSha256()
    const envSha256 = testEnvironmentSha256(process.env, testTimeoutMs)
    const cachedPlans: readonly CachedShardPlan[] = plans.map((plan) => ({
      plan,
      cachePath: shardCachePath(opts.suite, plan.index),
      identity: {
        head: before.head,
        suite: opts.suite,
        manifestSha256: manifestDigest,
        shardIndex: plan.index,
        shardFileCount: plan.files.length,
        shardFilesSha256: shardFilesSha256(REPO_ROOT, plan.files),
        toolchainSha256,
        testEnvSha256: envSha256,
        junit: opts.junitOut !== undefined,
      },
    }))

    const scanReachSinks = await executePlans({
      plans: cachedPlans,
      opts,
      runRoot,
      before,
      concurrency,
      testTimeoutMs,
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
    if (opts.junitOut !== undefined) mergeJunit(opts.junitOut)
    process.stdout.write(
      `[test:shards] PASS suite=${opts.suite} shards=1-${SHARD_COUNT}/${SHARD_COUNT} ` +
        `manifest_files=${manifest.length} head=${before.head}\n`,
    )
  } finally {
    rmSync(runRoot, { recursive: true, force: true })
    lease.release()
  }
}

await main()
