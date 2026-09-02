import { readFileSync } from "node:fs"

export interface TestShardPlan {
  readonly index: number
  readonly files: readonly string[]
  readonly exclusive: boolean
}

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

const SHARED_RESOURCE_PATH =
  /(?:^|\/)(?:integration|e2e)(?:\/|$)|(?:git|worktree|mcp|lsp|server|socket|process-tree|multi-process)/i

const SHARED_RESOURCE_SOURCE = [
  /\bBun\.listen\s*\(/,
  /\b(?:createServer|createConnection)\s*\(/,
  /\b(?:git\s+worktree|worktree\s+(?:add|remove|prune))\b/,
  /\b(?:QUANTA_HOME|QUANTA_BENCH_HOME|process\.env\.HOME)\b/,
  /\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/,
  /\b(?:killProcessTree|process\.kill)\s*\(/,
  /\b(?:writeFileSync|rmSync|renameSync|unlinkSync)\s*\([^\n]*(?:REPO_ROOT|repoRoot|process\.cwd\s*\(\s*\))/,
] as const

/**
 * Tests with an observable process-global or checkout-global resource run in
 * one exclusive worker. A false positive costs parallelism; a false negative
 * creates nondeterministic corruption or port collisions, so this is
 * intentionally conservative.
 */
export const usesSharedTestResource = (
  file: string,
  source: string = readFileSync(file, "utf8"),
): boolean =>
  SHARED_RESOURCE_PATH.test(file) || SHARED_RESOURCE_SOURCE.some((pattern) => pattern.test(source))

const roundRobin = (files: readonly string[], count: number): string[][] => {
  const groups = Array.from({ length: count }, () => [] as string[])
  for (const [position, file] of files.entries()) groups[position % count]?.push(file)
  return groups
}

/**
 * Produce an exact, disjoint partition from the one pre-expanded manifest.
 * Shared-resource tests occupy the final shard; every other shard is safe to
 * overlap with one peer process.
 */
export const createTestShardPlan = (
  manifest: readonly string[],
  shardCount: number,
  classify: (file: string) => boolean = usesSharedTestResource,
): readonly TestShardPlan[] => {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`[test:shards] invalid shard count: ${shardCount}`)
  }
  const sorted = [...manifest].sort()
  if (sorted.length < shardCount || new Set(sorted).size !== sorted.length) {
    throw new Error(
      `[test:shards] invalid manifest: files=${sorted.length} unique=${new Set(sorted).size} shards=${shardCount}`,
    )
  }

  const exclusive: string[] = []
  const regular: string[] = []
  for (const file of sorted) (classify(file) ? exclusive : regular).push(file)
  if (shardCount === 1) {
    const only = [{ index: 1, files: sorted, exclusive: exclusive.length > 0 }]
    assertTestShardPlan(manifest, only, shardCount)
    return only
  }
  const proportionalExclusive = Math.round((exclusive.length / sorted.length) * shardCount)
  const exclusiveShardCount =
    exclusive.length === 0
      ? 0
      : regular.length === 0
        ? shardCount
        : Math.max(1, Math.min(shardCount - 1, proportionalExclusive))
  const regularShardCount = shardCount - exclusiveShardCount
  if (
    regular.length < regularShardCount ||
    exclusive.length < exclusiveShardCount ||
    regularShardCount < 0
  ) {
    throw new Error(
      `[test:shards] cannot isolate shared resources: regular=${regular.length}/${regularShardCount} ` +
        `exclusive=${exclusive.length}/${exclusiveShardCount}`,
    )
  }
  const plans: TestShardPlan[] = roundRobin(regular, regularShardCount).map((files, offset) => ({
    index: offset + 1,
    files,
    exclusive: false,
  }))
  plans.push(
    ...roundRobin(exclusive, exclusiveShardCount).map((files, offset) => ({
      index: regularShardCount + offset + 1,
      files,
      exclusive: true,
    })),
  )
  assertTestShardPlan(manifest, plans, shardCount)
  return plans
}

export const assertTestShardPlan = (
  manifest: readonly string[],
  plans: readonly TestShardPlan[],
  shardCount: number,
): void => {
  if (plans.length !== shardCount || plans.some((plan) => plan.files.length === 0)) {
    throw new Error(
      `[test:shards] partition missing: expected=${shardCount} actual=${plans.length} empty=${plans.filter((p) => p.files.length === 0).length}`,
    )
  }
  const selected = plans.flatMap((plan) => plan.files)
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
