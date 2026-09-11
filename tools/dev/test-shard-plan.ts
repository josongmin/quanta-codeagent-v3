import { readFileSync } from "node:fs"

import { bucketForFile, DEFAULT_MEMBERSHIP } from "./test-shard-membership"

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

export interface TestChunk {
  readonly index: number
  readonly files: readonly string[]
  readonly resourceClass: TestResourceClass
  /** Sum of measured per-file wall estimates (fallback-weighted when unmeasured). */
  readonly predictedMs: number
}

export interface PlanTestChunksOptions {
  /**
   * REJECTED, not honoured.
   *
   * It was accepted, range-checked, threaded through `chunkOneGroup` as
   * `_targetChunkCount` — and never read. Membership is fixed per-class SHA
   * buckets by design, because a chunk's identity is what its cache receipt is
   * keyed on; a caller-supplied chunk count would re-cut every chunk on every
   * invocation and invalidate the whole cache. So the option could not be
   * honoured without breaking the thing it looked like it configured, and it
   * silently did nothing instead.
   *
   * The real control is `bucketsByClass` in `test-shard-membership.ts` — a
   * versioned, committed config, because changing it changes every chunk
   * identity and that should be a reviewable diff, not an argument.
   */
  readonly targetChunkCount?: number
  /** Measured per-file wall time; undefined = no measurement for that file. */
  readonly predictMs?: (file: string) => number | undefined
  readonly classify?: (file: string) => TestResourceClass
  /** Canonical repo-relative identity used for stable membership hashing. */
  readonly membershipFile?: (file: string) => string
}

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

/** Longest-processing-time-first is launch order only; membership is hashed. */

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

/**
 * Split one over-capacity bucket into the fewest sub-chunks that fit.
 *
 * `MAX_CHUNK_FILES` is a CHECKPOINT bound — "a failed campaign forfeits at most
 * this many files of green coverage per chunk" — so exceeding it is a
 * scheduling fact, not a corruption. It was a `throw`, which turned a growing
 * corpus into a runner that refuses to plan at all. Measured on this tree,
 * bucket `pure:4` holds 159 of 160: TWO more files hashing there and every
 * shard command dies with "membership bucket pure exceeds 160 files", with no
 * repair available except raising the ceiling — i.e. deleting the bound the
 * message is about.
 *
 * # Why contiguous slices of the sorted list
 *
 * Three candidate splits were measured for how many files change sub-chunk
 * (i.e. lose a cache receipt) when the bucket grows by one file:
 *
 *     bucket  append-last                insert-early
 *     size    round-robin/contig/hash    round-robin/contig/hash
 *     161->162      80 /   1 /  87            161 / 161 /  87
 *     200->201     100 /  40 / 104            200 / 200 / 104
 *     320->321     320 /   0 / 320            320 / 320 / 320
 *     400->401     133 /  80 / 130            267 / 400 / 138
 *
 * Contiguous wins the common case — a new test file appended to a bucket moves
 * 0-90 files rather than 80-320. Hashing into `ceil(n/MAX)` parts was also
 * DISQUALIFIED outright: hash buckets are uneven, so at 320 files its largest
 * part held 161 and broke the very ceiling this function exists to respect.
 *
 * Honest limitation: NO position-based split is stable against a file inserted
 * early in the sort order, because every later index shifts. That case
 * re-composes the bucket. It is the rarer one, and the alternative that would
 * fix it (rendezvous hashing) buys it at the cost of the ceiling guarantee.
 */
const splitOverCapacityBucket = (bin: readonly WeightedFile[]): readonly WeightedFile[][] => {
  if (bin.length <= MAX_CHUNK_FILES) return [[...bin]]
  const parts = Math.ceil(bin.length / MAX_CHUNK_FILES)
  // CODE-UNIT order, not `localeCompare`. The chunk's own `files` list (below)
  // and the manifest (`[...manifest].sort()`) both use the default comparator,
  // and `shardFilesSha256` is computed from that list — so partitioning by ICU
  // collation would make an over-capacity bucket's membership, and therefore its
  // cache receipt, depend on the host's locale data. Dormant while no bucket
  // exceeds the ceiling; armed the moment this path is first used, which is what
  // the split exists for.
  const byName = [...bin].sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
  )
  const out: WeightedFile[][] = Array.from({ length: parts }, () => [])
  byName.forEach((entry, index) => {
    // `min(parts - 1, …)` so the remainder lands in the last part rather than
    // creating a part beyond the allocation.
    ;(out[Math.min(parts - 1, Math.floor(index / MAX_CHUNK_FILES))] ?? []).push(entry)
  })
  return out.filter((part) => part.length > 0)
}

/** Per-class fixed membership buckets. Timing still labels launch order, not
 *  which files share a chunk. */
const chunkOneGroup = (
  resourceClass: TestResourceClass,
  group: readonly WeightedFile[],
  _totalWeight: number,
  membershipFile: (file: string) => string,
): UnindexedChunk[] => {
  const bins = new Map<number, WeightedFile[]>()
  for (const entry of group) {
    const { bucket } = bucketForFile(membershipFile(entry.file), resourceClass, DEFAULT_MEMBERSHIP)
    const bin = bins.get(bucket)
    if (bin === undefined) bins.set(bucket, [entry])
    else bin.push(entry)
  }
  return [...bins.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, bin]) =>
      splitOverCapacityBucket(bin).map((part) => {
        const ordered = [...part].sort(
          (left, right) => right.weightMs - left.weightMs || left.file.localeCompare(right.file),
        )
        return {
          files: [...part].map(({ file }) => file).sort(),
          resourceClass,
          predictedMs: Math.round(ordered.reduce((sum, entry) => sum + entry.weightMs, 0)),
        }
      }),
    )
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
  const membershipFile = options.membershipFile ?? ((file: string) => file)
  if (options.targetChunkCount !== undefined) {
    throw new Error(
      "[test:shards] targetChunkCount is not supported: membership is fixed per-class SHA " +
        "buckets so that a chunk's identity — and therefore its cache receipt — is stable. " +
        "Change `bucketsByClass` in tools/dev/test-shard-membership.ts, which is versioned " +
        "because it re-identifies every chunk.",
    )
  }

  const groups = groupWeightedFiles(sorted, classify, predictMs)
  const totalWeight = [...groups.values()].flat().reduce((sum, entry) => sum + entry.weightMs, 0)
  const chunks = [...groups.entries()].flatMap(([resourceClass, group]) =>
    chunkOneGroup(resourceClass, group, totalWeight, membershipFile),
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

/**
 * What the worker was last saying, for a watchdog kill.
 *
 * NOT the test file: measured on Bun 1.3.14, the console reporter prints a
 * `path.test.ts:` header only for files that FAIL, so a regex for it finds
 * nothing in exactly the case a hang produces — an inert feature that reads
 * like a working one. The spool tail is always there.
 */
export const spoolTail = (output: string, lines: number): string => {
  const kept = output
    .split("\n")
    .map((line) =>
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour escape sequence.
      line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd(),
    )
    .filter((line) => line.trim() !== "")
    .slice(-lines)
  return kept.length === 0 ? "<no output>" : kept.join("\n")
}

/** One watchdog observation of a running worker. */
export interface WatchdogTick {
  readonly spoolBytes: number
  readonly lastSpoolBytes: number
  readonly idleMs: number
  readonly inactivityTimeoutMs: number
  /** A kill has already been ordered for this worker. */
  readonly alreadyKilling: boolean
}

export type WatchdogAction = "progressed" | "waiting" | "kill" | "already-killing"

/**
 * What the watchdog should do with this tick.
 *
 * `already-killing` is not a nicety. A hung worker keeps its spool still BY
 * DEFINITION, so every tick after the first meets the kill condition too: the
 * first real hang caught by this watchdog printed its 20-line diagnostic tail
 * twice, a second apart, and would have kept printing until the process tree
 * finally died.
 */
export const watchdogAction = (tick: WatchdogTick): WatchdogAction => {
  if (tick.spoolBytes !== tick.lastSpoolBytes) return "progressed"
  if (tick.idleMs < tick.inactivityTimeoutMs) return "waiting"
  return tick.alreadyKilling ? "already-killing" : "kill"
}
