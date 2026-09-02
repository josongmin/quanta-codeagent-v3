import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, relative } from "node:path"

export const TEST_SHARD_CACHE_TTL_MS = 24 * 60 * 60_000

export interface TestShardCacheIdentity {
  readonly head: string
  readonly suite: string
  readonly manifestSha256: string
  readonly shardIndex: number
  readonly shardFileCount: number
  readonly shardFilesSha256: string
  readonly toolchainSha256: string
  readonly testEnvSha256: string
  readonly junit: boolean
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
 * Hash the effective child environment without persisting credentials. Values
 * synthesized per worker are replaced by stable semantic placeholders; every
 * other inherited variable remains part of the key and therefore fails closed.
 */
export const testEnvironmentSha256 = (
  env: Readonly<Record<string, string | undefined>>,
  testTimeoutMs: number,
): string => {
  const effective = { ...env }
  Object.assign(effective, {
    HOME: "<worker-home>",
    TMPDIR: "<worker-tmp>",
    PWD: "<repo-root>",
    QUANTA_HOME: "<worker-quanta-home>",
    QUANTA_PREFS_HOME: "<worker-prefs-home>",
    QUANTA_BENCH_RESULTS_DIR: "<worker-bench-results>",
    QUANTA_SCAN_REACH_RECORD: "<worker-scan-reach-sink>",
    QUANTA_TEST_TIMEOUT_SCALE: String(testTimeoutMs / 60_000),
  })
  const canonical = Object.entries(effective)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return sha256(JSON.stringify(canonical))
}

export const testToolchainSha256 = (): string =>
  sha256(
    JSON.stringify({
      bun: Bun.version,
      bunRevision: Bun.revision,
      nodeCompatibility: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  )

const receiptPayload = (receipt: Omit<SuccessfulTestShardReceipt, "receiptSha256">): string =>
  JSON.stringify(receipt)

const sameIdentity = (
  receipt: SuccessfulTestShardReceipt,
  expected: TestShardCacheIdentity,
): boolean =>
  receipt.head === expected.head &&
  receipt.suite === expected.suite &&
  receipt.manifestSha256 === expected.manifestSha256 &&
  receipt.shardIndex === expected.shardIndex &&
  receipt.shardFileCount === expected.shardFileCount &&
  receipt.shardFilesSha256 === expected.shardFilesSha256 &&
  receipt.toolchainSha256 === expected.toolchainSha256 &&
  receipt.testEnvSha256 === expected.testEnvSha256 &&
  receipt.junit === expected.junit

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
    typeof row.head !== "string" ||
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
