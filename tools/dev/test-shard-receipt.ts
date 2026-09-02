import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, relative } from "node:path"
import { externalToolchainFingerprint } from "./external-toolchain"

export const TEST_SHARD_CACHE_TTL_MS = 24 * 60 * 60_000

export interface TestShardCacheIdentity {
  /**
   * Content hash of everything tracked that a test can read, minus prose and
   * minus the chunk-bound test files. See {@link trackedTreeSha256}: this
   * replaced a `src`+`tools` scan that could not see `tests/setup.ts`,
   * `bunfig.toml` or any fixture, and therefore replayed green receipts across
   * changes that alter every test's behaviour.
   */
  readonly treeSha256: string
  readonly suite: string
  readonly manifestSha256: string
  readonly shardIndex: number
  readonly shardFileCount: number
  readonly shardFilesSha256: string
  readonly toolchainSha256: string
  readonly testEnvSha256: string
  readonly junit: boolean
  /**
   * Did this chunk's files run CONCURRENTLY inside the worker?
   *
   * Without it the cache had a systematic blind spot: a loaded box plans
   * serial, banks a green, and a later idle box plans `pure` chunks
   * concurrently but HITS those serial receipts — so the concurrent schedule
   * is never actually exercised, and a file that only breaks when interleaved
   * with a peer is passed by a receipt that never interleaved it.
   */
  readonly filesRunConcurrently: boolean
}

export interface SuccessfulTestShardReceipt extends TestShardCacheIdentity {
  readonly schema: "quanta.test-shard-success.v1"
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly executedFiles: number
  readonly scanReachRecords: readonly ScanReachRecord[]
  readonly junitXml?: string
  readonly receiptSha256: string
}

export type TestShardCacheLookup =
  | { readonly kind: "hit"; readonly receipt: SuccessfulTestShardReceipt }
  | { readonly kind: "miss"; readonly reason: string }

const sha256 = (value: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex")

const validSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

/** Content identity is independent of mtimes and file-system enumeration order. */
export const shardFilesSha256 = (repoRoot: string, files: readonly string[]): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const file of [...files].sort()) {
    hasher.update(relative(repoRoot, file))
    hasher.update("\0")
    hasher.update(sha256(readFileSync(file)))
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

/**
 * Paths that cannot change what a test observes.
 *
 * Prose only. Everything else tracked by Git is part of the identity, so a new
 * file TYPE is included by default and the list fails closed.
 */
const PROSE_ONLY = /^docs\/|\.md$/

/** Per-chunk bound by `shardFilesSha256`; hashing them here would make one
 *  test edit invalidate every chunk, which is the coarseness this replaced. */
const CHUNK_BOUND = /(?:^|\/)__tests__\/|\.test\.ts$/

/**
 * Content identity of everything the tests can read.
 *
 * MEASURED HOLE THIS CLOSES. The previous version hashed `src` and `tools`
 * `.ts` files only. `tests/setup.ts` — which bunfig preloads into EVERY test —
 * `tests/_helpers/*`, `bunfig.toml`, `package.json` and every JSON fixture a
 * ratchet reads were all invisible. Reproduced: append a line to
 * `tests/setup.ts`, commit, re-run — every chunk reported CACHE HIT and the
 * suite printed PASS having executed zero tests.
 *
 * Git already content-addresses the tree, so this is one `ls-tree` (0.2s for
 * 14k files) rather than 14k reads. The runner refuses a dirty checkout, so
 * HEAD and the working tree are the same thing here.
 */
export const trackedTreeSha256 = (repoRoot: string): string => {
  const result = Bun.spawnSync(["git", "ls-tree", "-r", "HEAD", "--format=%(path) %(objectname)"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `[test:shards] cannot read the tree for cache identity: ${result.stderr.toString()}`,
    )
  }
  const hasher = new Bun.CryptoHasher("sha256")
  const lines = result.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "")
    .filter((line) => {
      const path = line.slice(0, line.lastIndexOf(" "))
      return !PROSE_ONLY.test(path) && !CHUNK_BOUND.test(path)
    })
    .sort()
  if (lines.length === 0) throw new Error("[test:shards] empty tree listing for cache identity")
  for (const line of lines) {
    hasher.update(line)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}

const RELEVANT_ENV_EXACT = new Set(["CI", "NODE_ENV", "PATH", "REQUIRE_CONTRACT", "TZ", "LANG"])

const dedupePath = (value: string): string => {
  const seen = new Set<string>()
  return value
    .split(":")
    .filter((entry) => {
      if (seen.has(entry)) return false
      seen.add(entry)
      return true
    })
    .join(":")
}

/**
 * Hash only the environment a test verdict can actually depend on: the CI/test
 * switches, locale/zone, PATH (first-occurrence order, duplicates collapsed —
 * `bun run` re-prepends its .bin chain per nesting level), and every BUN_ or
 * QUANTA_ knob. Hashing ALL inherited env made an unrelated terminal variable
 * (ITERM_SESSION_ID, a new SSH agent socket) a guaranteed cache miss.
 * Worker-synthesized values are replaced by stable semantic placeholders.
 */
export const testEnvironmentSha256 = (
  env: Readonly<Record<string, string | undefined>>,
  testTimeoutMs: number,
): string => {
  const effective: Record<string, string | undefined> = { ...env }
  Object.assign(effective, {
    QUANTA_HOME: "<worker-quanta-home>",
    QUANTA_PREFS_HOME: "<worker-prefs-home>",
    QUANTA_BENCH_RESULTS_DIR: "<worker-bench-results>",
    QUANTA_SCAN_REACH_RECORD: "<worker-scan-reach-sink>",
    QUANTA_TEST_TIMEOUT_SCALE: String(testTimeoutMs / 60_000),
  })
  const canonical = Object.entries(effective)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .filter(
      ([key]) => RELEVANT_ENV_EXACT.has(key) || key.startsWith("BUN_") || key.startsWith("QUANTA_"),
    )
    .filter(([key]) => !key.startsWith("QUANTA_VERIFICATION_LEASE_"))
    .map(([key, value]): [string, string] => [key, key === "PATH" ? dedupePath(value) : value])
    .sort(([left], [right]) => left.localeCompare(right))
  return sha256(JSON.stringify(canonical))
}

export const testToolchainSha256 = (
  externalTools: Record<string, string> = externalToolchainFingerprint(),
): string =>
  sha256(
    JSON.stringify({
      bun: Bun.version,
      bunRevision: Bun.revision,
      nodeCompatibility: process.version,
      platform: process.platform,
      arch: process.arch,
      externalTools,
    }),
  )

const receiptPayload = (receipt: Omit<SuccessfulTestShardReceipt, "receiptSha256">): string =>
  JSON.stringify(receipt)

const sameIdentity = (
  receipt: SuccessfulTestShardReceipt,
  expected: TestShardCacheIdentity,
): boolean =>
  // `shardIndex` is deliberately NOT part of the identity: chunk composition
  // is bound by shardFilesSha256 (path + content of every file), while the
  // ordinal is a presentation label that can shift when a NEIGHBOR chunk
  // changes. Everything else must match exactly.
  receipt.treeSha256 === expected.treeSha256 &&
  receipt.suite === expected.suite &&
  receipt.manifestSha256 === expected.manifestSha256 &&
  receipt.shardFileCount === expected.shardFileCount &&
  receipt.shardFilesSha256 === expected.shardFilesSha256 &&
  receipt.toolchainSha256 === expected.toolchainSha256 &&
  receipt.testEnvSha256 === expected.testEnvSha256 &&
  receipt.junit === expected.junit &&
  // IMPLICATION, not equality. Running files concurrently is the strictly
  // harder condition — it is the one that can interleave shared module state —
  // so a green earned that way also answers for a serial plan. A serial green
  // answers only for a serial plan.
  (receipt.filesRunConcurrently || !expected.filesRunConcurrently)

const isScanReachRecord = (value: unknown): value is ScanReachRecord => {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === "string" &&
    row.id !== "" &&
    Number.isSafeInteger(row.walked) &&
    (row.walked as number) >= 0 &&
    (row.matched === undefined ||
      (Number.isSafeInteger(row.matched) && (row.matched as number) >= 0))
  )
}

const parseSuccessfulShardReceipt = (value: unknown): SuccessfulTestShardReceipt | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  if (
    row.schema !== "quanta.test-shard-success.v1" ||
    !validSha256(row.treeSha256) ||
    typeof row.suite !== "string" ||
    !validSha256(row.manifestSha256) ||
    !Number.isSafeInteger(row.shardIndex) ||
    (row.shardIndex as number) < 1 ||
    !Number.isSafeInteger(row.shardFileCount) ||
    (row.shardFileCount as number) < 1 ||
    !validSha256(row.shardFilesSha256) ||
    !validSha256(row.toolchainSha256) ||
    !validSha256(row.testEnvSha256) ||
    typeof row.junit !== "boolean" ||
    typeof row.filesRunConcurrently !== "boolean" ||
    !Number.isSafeInteger(row.createdAtMs) ||
    !Number.isSafeInteger(row.expiresAtMs) ||
    !Number.isSafeInteger(row.executedFiles) ||
    (row.executedFiles as number) < 1 ||
    !Array.isArray(row.scanReachRecords) ||
    !row.scanReachRecords.every(isScanReachRecord) ||
    (row.junitXml !== undefined && typeof row.junitXml !== "string") ||
    !validSha256(row.receiptSha256)
  ) {
    return undefined
  }
  return row as unknown as SuccessfulTestShardReceipt
}

export const loadSuccessfulTestShardReceipt = (input: {
  readonly path: string
  readonly expected: TestShardCacheIdentity
  readonly nowMs?: number
}): TestShardCacheLookup => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(input.path, "utf8"))
  } catch {
    return { kind: "miss", reason: "absent-or-corrupt" }
  }
  const receipt = parseSuccessfulShardReceipt(parsed)
  if (receipt === undefined) return { kind: "miss", reason: "invalid-schema" }
  const { receiptSha256, ...payload } = receipt
  if (sha256(receiptPayload(payload)) !== receiptSha256) {
    return { kind: "miss", reason: "integrity" }
  }
  const nowMs = input.nowMs ?? Date.now()
  if (
    receipt.expiresAtMs - receipt.createdAtMs !== TEST_SHARD_CACHE_TTL_MS ||
    receipt.createdAtMs > nowMs ||
    receipt.expiresAtMs <= nowMs
  ) {
    return { kind: "miss", reason: "expired" }
  }
  if (!sameIdentity(receipt, input.expected)) return { kind: "miss", reason: "input-mismatch" }
  if (receipt.executedFiles !== receipt.shardFileCount) {
    return { kind: "miss", reason: "discovery-mismatch" }
  }
  if (receipt.junit !== (receipt.junitXml !== undefined)) {
    return { kind: "miss", reason: "junit-mismatch" }
  }
  if (
    receipt.junitXml !== undefined &&
    (!receipt.junitXml.includes("<testsuites") ||
      !receipt.junitXml.includes("</testsuites>") ||
      !receipt.junitXml.includes("<testcase"))
  ) {
    return { kind: "miss", reason: "junit-invalid" }
  }
  return { kind: "hit", receipt }
}

export const writeSuccessfulTestShardReceiptAtomic = (input: {
  readonly path: string
  readonly identity: TestShardCacheIdentity
  readonly executedFiles: number
  readonly scanReachRecords: readonly ScanReachRecord[]
  readonly junitXml?: string
  readonly nowMs?: number
}): SuccessfulTestShardReceipt => {
  if (
    input.executedFiles < 1 ||
    !Number.isSafeInteger(input.executedFiles) ||
    input.executedFiles !== input.identity.shardFileCount ||
    input.scanReachRecords.some((record) => !isScanReachRecord(record)) ||
    input.identity.junit !== (input.junitXml !== undefined)
  ) {
    throw new Error("[test:shards] refusing to cache an incomplete shard receipt")
  }
  const createdAtMs = input.nowMs ?? Date.now()
  const payload: Omit<SuccessfulTestShardReceipt, "receiptSha256"> = {
    schema: "quanta.test-shard-success.v1",
    ...input.identity,
    createdAtMs,
    expiresAtMs: createdAtMs + TEST_SHARD_CACHE_TTL_MS,
    executedFiles: input.executedFiles,
    scanReachRecords: [...input.scanReachRecords],
    ...(input.junitXml === undefined ? {} : { junitXml: input.junitXml }),
  }
  const receipt: SuccessfulTestShardReceipt = {
    ...payload,
    receiptSha256: sha256(receiptPayload(payload)),
  }
  mkdirSync(dirname(input.path), { recursive: true })
  const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { flag: "wx" })
    renameSync(temporary, input.path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return receipt
}

export interface ScanReachRecord {
  readonly id: string
  readonly walked: number
  readonly matched?: number
}

const parseScanReachRecord = (line: string, sink: string): ScanReachRecord => {
  const record = JSON.parse(line) as ScanReachRecord
  const invalidMatched =
    record.matched !== undefined && (!Number.isSafeInteger(record.matched) || record.matched < 0)
  if (
    record.id === "" ||
    !Number.isSafeInteger(record.walked) ||
    record.walked < 0 ||
    invalidMatched
  ) {
    throw new Error(`[test:shards] invalid scan-reach record in ${sink}`)
  }
  return record
}

const mergeRecord = (
  previous: Omit<ScanReachRecord, "id"> | undefined,
  record: ScanReachRecord,
): Omit<ScanReachRecord, "id"> => {
  const walked = previous === undefined ? record.walked : Math.min(previous.walked, record.walked)
  const matchedValues = [previous?.matched, record.matched].filter(
    (value): value is number => value !== undefined,
  )
  return matchedValues.length === 0 ? { walked } : { walked, matched: Math.min(...matchedValues) }
}

export const mergeScanReachSinks = (sinks: readonly string[]): readonly ScanReachRecord[] => {
  const records = new Map<string, Omit<ScanReachRecord, "id">>()
  for (const sink of sinks) {
    const lines = readFileSync(sink, "utf8").split("\n").filter(Boolean)
    for (const line of lines) {
      const record = parseScanReachRecord(line, sink)
      records.set(record.id, mergeRecord(records.get(record.id), record))
    }
  }
  return [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, reach]) => ({ id, ...reach }))
}

export const writeScanReachReceiptAtomic = (input: {
  readonly path: string
  readonly head: string
  readonly suite: "unit" | "full"
  readonly manifestSha256: string
  readonly sinks: readonly string[]
}): void => {
  const records = mergeScanReachSinks(input.sinks)
  if (records.length === 0) {
    throw new Error("[test:shards] scan-reach receipt is empty after a successful suite")
  }
  mkdirSync(dirname(input.path), { recursive: true })
  const temporary = `${input.path}.tmp-${process.pid}`
  writeFileSync(
    temporary,
    `${JSON.stringify(
      {
        schema: "quanta.scan-reach-receipt.v1",
        head: input.head,
        suite: input.suite,
        manifestSha256: input.manifestSha256,
        childExit: 0,
        records,
      },
      null,
      2,
    )}\n`,
  )
  renameSync(temporary, input.path)
}
