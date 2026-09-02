import { readFileSync } from "node:fs"

export interface MemoryBudget {
  readonly totalBytes: number
  readonly availableBytes: number
}

export interface CpuBudget {
  readonly loadAverage1m: number
  readonly cpuCount: number
}

const TWO_WORKER_MIN_TOTAL_BYTES = 32 * 1024 ** 3
const TWO_WORKER_MIN_AVAILABLE_BYTES = 16 * 1024 ** 3

// A second Bun worker is useful only when the host can absorb two observed
// 4-8 GiB shard peaks without immediately paging. This is deliberately a
// fallback, not an operator override: the runner never exceeds two workers.
export const chooseShardConcurrency = (memory: MemoryBudget): 1 | 2 =>
  memory.totalBytes >= TWO_WORKER_MIN_TOTAL_BYTES &&
  memory.availableBytes >= TWO_WORKER_MIN_AVAILABLE_BYTES
    ? 2
    : 1

// A passing test pays none of this budget. Keep the normal watchdog at two
// minutes so a load average sampled before a long serial campaign cannot leave
// late real-process tests with only the historical 60-second ceiling. Internal
// pressure-aware guards receive BASE/60_000 = 2 and retain half this budget for
// command failure, leaving Bun time to run teardown.
const BASE_TEST_TIMEOUT_MS = 120_000
const MAX_TEST_TIMEOUT_MS = 300_000

/**
 * Preserve a bounded defect signal, but avoid false timeouts when an externally
 * contended host gives the single safe worker only a fraction of a CPU. The
 * two-minute floor also covers pressure that rises after this one-time sample.
 * Each 2x oversubscription adds one bounded timeout quantum; even extreme
 * pressure can never widen an individual test beyond five minutes.
 */
export const chooseShardTestTimeoutMs = (cpu: CpuBudget): number => {
  if (
    !Number.isFinite(cpu.loadAverage1m) ||
    cpu.loadAverage1m < 0 ||
    !Number.isSafeInteger(cpu.cpuCount) ||
    cpu.cpuCount < 1
  ) {
    return BASE_TEST_TIMEOUT_MS
  }
  const pressureFactor = Math.max(1, Math.ceil(cpu.loadAverage1m / (cpu.cpuCount * 2)))
  return Math.min(MAX_TEST_TIMEOUT_MS, BASE_TEST_TIMEOUT_MS * pressureFactor)
}

export interface IntraWorkerParallelismInput {
  readonly resourceClass: TestResourceClass
  readonly cpuCount: number
  /** How many worker PROCESSES the runner will overlap. */
  readonly workers: number
  /** load/(2*cpus) quanta, 1 when the host is idle. */
  readonly pressure: number
}

/** Never more in flight inside one worker than this, whatever the box. */
export const MAX_INTRA_WORKER_PARALLELISM = 8

/**
 * How many test FILES one worker may run concurrently inside its process.
 *
 * The runner used to pin every worker to `--parallel=1`, which is the correct
 * and only safe answer for a corpus you cannot classify — and this runner can
 * classify it. Measured on a 24-file `pure` sample, identical verdicts (295
 * pass / 0 fail / exit 0, repeated) at 1 and at 8, with wall time 27s -> 11s;
 * under host load the same comparison was 77-92s -> 12s.
 *
 * ONLY `pure` gets it. Every other class names a process-global or
 * checkout-global resource — a port, a browser, the repo working tree, HOME —
 * and running two such files inside one process is precisely what the class
 * system exists to prevent. That asymmetry is the whole safety argument, so it
 * is expressed as a hard branch rather than a tuned number.
 *
 * The budget is CPU headroom shared across workers, halved because these tests
 * spawn real subprocesses (CLIs, language servers, git) and so cost more than
 * one core each, then divided again by measured pressure so a box that is
 * already oversubscribed does not get piled on.
 */
export const chooseIntraWorkerParallelism = (input: IntraWorkerParallelismInput): number => {
  if (input.resourceClass !== "pure") return 1
  if (
    !Number.isSafeInteger(input.cpuCount) ||
    input.cpuCount < 1 ||
    !Number.isSafeInteger(input.workers) ||
    input.workers < 1 ||
    !Number.isFinite(input.pressure) ||
    input.pressure < 1
  ) {
    return 1
  }
  const budget = Math.floor(input.cpuCount / (2 * input.workers * input.pressure))
  return Math.max(1, Math.min(MAX_INTRA_WORKER_PARALLELISM, budget))
}

export interface OverloadDelayInput {
  /** load/(2*cpus) quanta — the same measure that scales the test timeout. */
  readonly pressure: number
  readonly budgetLeftMs: number
  readonly pollMs: number
  readonly thresholdPressure: number
}

/**
 * How long to yield to an overloaded host before starting the next worker.
 *
 * The budget is CAMPAIGN-wide, and that is the whole point: the first version
 * granted a fresh 10-minute deadline on every start with an empty box — which,
 * in a serial campaign, is every chunk — so a host that stayed loaded could
 * stretch 30 chunks by 10 minutes each and spend five hours mostly asleep,
 * having reported nothing but "delaying" lines. Yielding is worth a bounded
 * amount of time in TOTAL; past that, running slowly beats not running.
 */
export const nextOverloadDelayMs = (input: OverloadDelayInput): number => {
  if (!Number.isFinite(input.pressure) || input.pressure < input.thresholdPressure) return 0
  if (!(input.budgetLeftMs > 0)) return 0
  return Math.min(input.pollMs, input.budgetLeftMs)
}

/**
 * Resource classes. A class names the process-global or checkout-global
 * resource a test file observably uses; only INCOMPATIBLE classes serialize.
 * "pure" files (no detected shared resource) may overlap anything — they
 * already overlap each other today, and a file that touches nothing shared
 * cannot corrupt a resource-owning peer.
 */
export const TEST_RESOURCE_CLASSES = [
  "pure",
  "worktree",
  "repo-write",
  "browser",
  "lsp",
  "port",
  "process-global",
  "integration-path",
] as const

export type TestResourceClass = (typeof TEST_RESOURCE_CLASSES)[number]

/** Source detectors, most specific first; the first match names the class. */
const CLASS_SOURCE_DETECTORS: readonly (readonly [TestResourceClass, RegExp])[] = [
  // Shell form ("git worktree add …") AND argv-array form (["worktree", "add"]).
  ["worktree", /\bgit\s+worktree\b|\bworktree\b[^\n]{0,40}\b(?:add|remove|prune|lock)\b/],
  [
    "repo-write",
    /\b(?:writeFileSync|rmSync|renameSync|unlinkSync)\s*\([^\n]*(?:REPO_ROOT|repoRoot|process\.cwd\s*\(\s*\))/,
  ],
  // `REAL_CHROME` is this repo's own real-spawn gate: the browser e2e flips it
  // only once a live CDP session exists. It is listed because the four tokens
  // beside it are OTHER projects' vocabulary — our CDP adapter says `cdp` and
  // `chrome`, so the one test that actually spawns Chrome scored zero matches
  // and got overlapped with 135 integration files (2026-09-02 gate audit: a 60s
  // navigate timeout that reproduces 0/4 in isolation). Deliberately NOT a bare
  // /cdp|chrome/ — that reclassifies 56 files, nearly all pure unit tests with
  // no browser, and serializes the suite for nothing.
  ["browser", /puppeteer|playwright|chromium|--headless|REAL_CHROME/i],
  ["lsp", /\b(?:typescript-language-server|pyright|rust-analyzer|gopls|lldb|lsp)\b/i],
  [
    "port",
    /\bBun\.listen\s*\(|\b(?:createServer|createConnection)\s*\(|\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/,
  ],
  [
    "process-global",
    /\b(?:killProcessTree|process\.kill)\s*\(|\b(?:QUANTA_HOME|QUANTA_BENCH_HOME|process\.env\.HOME)\b/,
  ],
] as const

const SHARED_RESOURCE_PATH =
  /(?:^|\/)(?:integration|e2e)(?:\/|$)|(?:git|worktree|mcp|lsp|server|socket|process-tree|multi-process)/i

/**
 * Classify one test file. Source evidence wins over the path heuristic: a
 * path-only match (integration/e2e naming) with no specific marker lands in
 * "integration-path", which stays serialized against every non-pure class.
 */
export const classifyTestResource = (
  file: string,
  source: string = readFileSync(file, "utf8"),
): TestResourceClass => {
  for (const [resourceClass, pattern] of CLASS_SOURCE_DETECTORS) {
    if (pattern.test(source)) return resourceClass
  }
  return SHARED_RESOURCE_PATH.test(file) ? "integration-path" : "pure"
}

/**
 * Non-pure classes serialize against EVERY non-pure class until a specific
 * pair is measured safe under real contention. This is already strictly more
 * parallel than the previous binary plan: the exclusive corpus (19.6% of the
 * suite, formerly 100% serial waves) now overlaps the pure corpus.
 */
const VALIDATED_NONPURE_OVERLAPS: ReadonlySet<string> = new Set()

const overlapKey = (a: TestResourceClass, b: TestResourceClass): string => [a, b].sort().join("+")

/**
 * Classes measured unsafe even against `pure`.
 *
 * `pure` overlapping everything is this plan's whole parallelism win, and it
 * holds for every resource whose hazard is its KIND — two `port` chunks fight
 * over sockets, a `pure` peer cannot. A real browser is the exception: what
 * breaks it is the peer's CPU appetite, which `pure` says nothing about. The
 * 2026-09-02 gate audit measured it twice — a real-Chrome file lost an HONORED,
 * pressure-scaled 60,000ms CDP budget by 1.88ms while scheduled beside a 137-file
 * `pure` chunk, and passed 3/3 alone. Another timeout multiplier would only
 * record the contention as if it were a property of the code.
 *
 * Safe because the scheduler starts a task unconditionally when nothing is
 * running (`test-shard-lifecycle.ts` `startEligibleTasks`), so an exclusive
 * chunk waits for an empty box rather than starving. Pinned by
 * "an exclusive class still runs" in tests/unit/test-shard-plan.test.ts.
 */
const EXCLUSIVE_CLASSES: ReadonlySet<TestResourceClass> = new Set<TestResourceClass>(["browser"])

export const resourceClassesOverlap = (a: TestResourceClass, b: TestResourceClass): boolean =>
  EXCLUSIVE_CLASSES.has(a) || EXCLUSIVE_CLASSES.has(b)
    ? false
    : a === "pure" || b === "pure" || VALIDATED_NONPURE_OVERLAPS.has(overlapKey(a, b))

/** Compatibility shim for the previous binary classifier. */
export const usesSharedTestResource = (
  file: string,
  source: string = readFileSync(file, "utf8"),
): boolean => classifyTestResource(file, source) !== "pure"

export interface TestChunk {
  readonly index: number
  readonly files: readonly string[]
  readonly resourceClass: TestResourceClass
  /** Sum of measured per-file wall estimates (fallback-weighted when unmeasured). */
  readonly predictedMs: number
}

export interface PlanTestChunksOptions {
  readonly targetChunkCount?: number
  /** Measured per-file wall time; undefined = no measurement for that file. */
  readonly predictMs?: (file: string) => number | undefined
  readonly classify?: (file: string) => TestResourceClass
}

const DEFAULT_TARGET_CHUNK_COUNT = 24
/** Checkpoint bound: a failed campaign forfeits at most this many files of
 *  green coverage per chunk, however small a group's time share is. */
const MAX_CHUNK_FILES = 160

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

interface WeightedFile {
  readonly file: string
  readonly weightMs: number
  readonly measured: boolean
}

/** Longest-processing-time-first into `binCount` bins; deterministic ties. */
const lptBins = (files: readonly WeightedFile[], binCount: number): WeightedFile[][] => {
  const bins = Array.from({ length: binCount }, () => [] as WeightedFile[])
  const sums = new Array<number>(binCount).fill(0)
  const ordered = [...files].sort(
    (left, right) => right.weightMs - left.weightMs || left.file.localeCompare(right.file),
  )
  for (const entry of ordered) {
    let target = 0
    for (let bin = 1; bin < binCount; bin += 1) {
      const currentSum = sums[bin] ?? 0
      const targetSum = sums[target] ?? 0
      if (currentSum < targetSum) target = bin
    }
    bins[target]?.push(entry)
    sums[target] = (sums[target] ?? 0) + entry.weightMs
  }
  return bins.filter((bin) => bin.length > 0)
}

/**
 * Partition the manifest into resource-classed, timing-balanced chunks.
 *
 * - Every file appears in exactly one chunk (asserted).
 * - A chunk holds files of ONE class, so the scheduler can overlap chunks
 *   whose classes are compatible.
 * - Chunk sizes follow measured per-file wall time (LPT) where available;
 *   unmeasured files carry the manifest's median measured weight so a cold
 *   store degrades to file-count balancing, never to a crash or a skew.
 * - Finer chunks than the old 8 fixed shards double as resume checkpoints:
 *   a failed campaign re-runs only the chunks without a green receipt.
 */
const validWeight = (ms: number | undefined): ms is number =>
  ms !== undefined && Number.isFinite(ms) && ms > 0

/** Group weighted files by class; unmeasured files carry the measured median. */
const groupWeightedFiles = (
  sorted: readonly string[],
  classify: (file: string) => TestResourceClass,
  predictMs: (file: string) => number | undefined,
): Map<TestResourceClass, WeightedFile[]> => {
  const measured = sorted.map(predictMs).filter(validWeight)
  const fallbackWeightMs = median(measured) ?? 1_000
  const groups = new Map<TestResourceClass, WeightedFile[]>()
  for (const file of sorted) {
    const ms = predictMs(file)
    const entry: WeightedFile = validWeight(ms)
      ? { file, weightMs: ms, measured: true }
      : { file, weightMs: fallbackWeightMs, measured: false }
    const group = groups.get(classify(file))
    if (group === undefined) groups.set(classify(file), [entry])
    else group.push(entry)
  }
  return groups
}

interface UnindexedChunk {
  readonly files: readonly string[]
  readonly resourceClass: TestResourceClass
  readonly predictedMs: number
}

/** Per-class LPT bins; count follows the class's time share, bounded by the
 *  checkpoint size cap. */
const chunkOneGroup = (
  resourceClass: TestResourceClass,
  group: readonly WeightedFile[],
  totalWeight: number,
  targetChunkCount: number,
): UnindexedChunk[] => {
  const groupWeight = group.reduce((sum, entry) => sum + entry.weightMs, 0)
  const proportional = Math.round((groupWeight / totalWeight) * targetChunkCount)
  const checkpointFloor = Math.ceil(group.length / MAX_CHUNK_FILES)
  const binCount = Math.max(1, checkpointFloor, Math.min(group.length, proportional))
  return lptBins(group, binCount).map((bin) => ({
    files: bin.map(({ file }) => file).sort(),
    resourceClass,
    predictedMs: Math.round(bin.reduce((sum, entry) => sum + entry.weightMs, 0)),
  }))
}

export const planTestChunks = (
  manifest: readonly string[],
  options: PlanTestChunksOptions = {},
): readonly TestChunk[] => {
  const sorted = [...manifest].sort()
  if (sorted.length === 0 || new Set(sorted).size !== sorted.length) {
    throw new Error(
      `[test:shards] invalid manifest: files=${sorted.length} unique=${new Set(sorted).size}`,
    )
  }
  const classify = options.classify ?? classifyTestResource
  const predictMs = options.predictMs ?? (() => undefined)
  const targetChunkCount = options.targetChunkCount ?? DEFAULT_TARGET_CHUNK_COUNT
  if (!Number.isSafeInteger(targetChunkCount) || targetChunkCount < 1) {
    throw new Error(`[test:shards] invalid target chunk count: ${targetChunkCount}`)
  }

  const groups = groupWeightedFiles(sorted, classify, predictMs)
  const totalWeight = [...groups.values()].flat().reduce((sum, entry) => sum + entry.weightMs, 0)
  const chunks = [...groups.entries()].flatMap(([resourceClass, group]) =>
    chunkOneGroup(resourceClass, group, totalWeight, targetChunkCount),
  )

  // Deterministic indices derived from composition (class + first file), so a
  // stable corpus keeps stable chunk identities across runs. The scheduler
  // orders execution by predictedMs, not by this label.
  chunks.sort(
    (left, right) =>
      left.resourceClass.localeCompare(right.resourceClass) ||
      (left.files[0] ?? "").localeCompare(right.files[0] ?? ""),
  )
  const indexed: TestChunk[] = chunks.map((chunk, offset) => ({ index: offset + 1, ...chunk }))
  assertTestChunkPlan(manifest, indexed)
  return indexed
}

export const assertTestChunkPlan = (
  manifest: readonly string[],
  chunks: readonly TestChunk[],
): void => {
  if (chunks.length === 0 || chunks.some((chunk) => chunk.files.length === 0)) {
    throw new Error(
      `[test:shards] partition missing: chunks=${chunks.length} empty=${chunks.filter((c) => c.files.length === 0).length}`,
    )
  }
  const indices = chunks.map((chunk) => chunk.index)
  if (new Set(indices).size !== chunks.length || indices.some((index) => index < 1)) {
    throw new Error("[test:shards] chunk indices must be unique and positive")
  }
  const selected = chunks.flatMap((chunk) => chunk.files)
  const expected = [...manifest].sort()
  const actual = [...selected].sort()
  if (
    selected.length !== new Set(selected).size ||
    actual.length !== expected.length ||
    actual.some((file, index) => file !== expected[index])
  ) {
    throw new Error(
      `[test:shards] partition is not exact: manifest=${expected.length} selected=${selected.length} unique=${new Set(selected).size}`,
    )
  }
}

const FILE_COUNT_LINE = /^Ran \d+ tests? across (\d+) files?\./gm

/** Last Bun suite footer; nested child-test output can contain earlier footers. */
export const parseExecutedFileCount = (output: string): number | undefined => {
  let count: number | undefined
  for (const match of output.matchAll(FILE_COUNT_LINE)) {
    if (match[1] !== undefined) count = Number.parseInt(match[1], 10)
  }
  return count
}
