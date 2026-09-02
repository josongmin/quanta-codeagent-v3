import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertTestShardPlan,
  chooseShardConcurrency,
  chooseShardTestTimeoutMs,
  createTestShardPlan,
  parseExecutedFileCount,
  usesSharedTestResource,
} from "../../tools/dev/test-shard-plan"
import {
  loadSuccessfulTestShardReceipt,
  mergeScanReachSinks,
  shardFilesSha256,
  TEST_SHARD_CACHE_TTL_MS,
  testEnvironmentSha256,
  writeScanReachReceiptAtomic,
  writeSuccessfulTestShardReceiptAtomic,
} from "../../tools/dev/test-shard-receipt"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("explicit full-suite shard plan", () => {
  test("partitions one manifest exactly and isolates shared-resource files", () => {
    const files = Array.from({ length: 17 }, (_, index) => `tests/unit/file-${index}.test.ts`)
    const shared = new Set(["tests/unit/file-3.test.ts", "tests/unit/file-11.test.ts"])
    const plan = createTestShardPlan(files, 4, (file) => shared.has(file))

    expect(plan).toHaveLength(4)
    expect(plan.filter(({ exclusive }) => exclusive)).toEqual([
      { index: 4, files: [...shared].sort(), exclusive: true },
    ])
    expect(() => assertTestShardPlan(files, plan, 4)).not.toThrow()

    // Red-on-injection: losing one explicit path must invalidate the verdict.
    const missing = plan.map((shard, index) =>
      index === 0 ? { ...shard, files: shard.files.slice(1) } : shard,
    )
    expect(() => assertTestShardPlan(files, missing, 4)).toThrow("partition is not exact")
  })

  test("balances an all-exclusive suite across every serial shard", () => {
    const files = Array.from({ length: 24 }, (_, index) => `tests/integration/${index}.test.ts`)
    const plan = createTestShardPlan(files, 8, () => true)
    expect(plan.every(({ exclusive }) => exclusive)).toBe(true)
    expect(plan.map(({ files: shardFiles }) => shardFiles.length)).toEqual([3, 3, 3, 3, 3, 3, 3, 3])
    expect(() => assertTestShardPlan(files, plan, 8)).not.toThrow()
  })

  test("shared-resource classifier catches checkout, port, and process-global owners", () => {
    expect(usesSharedTestResource("tests/unit/plain.test.ts", "expect(1).toBe(1)")).toBe(false)
    expect(usesSharedTestResource("tests/integration/plain.test.ts", "")).toBe(true)
    expect(usesSharedTestResource("tests/unit/plain.test.ts", "Bun.listen({ port: 0 })")).toBe(true)
    expect(
      usesSharedTestResource("tests/unit/plain.test.ts", 'const endpoint = "127.0.0.1:14318"'),
    ).toBe(true)
    expect(
      usesSharedTestResource(
        "tests/unit/plain.test.ts",
        "writeFileSync(join(REPO_ROOT, 'fixture'), 'x')",
      ),
    ).toBe(true)
  })

  test("bounds concurrency at two and falls back when reclaimable memory is insufficient", () => {
    expect(
      chooseShardConcurrency({ totalBytes: 48 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 }),
    ).toBe(2)
    expect(
      chooseShardConcurrency({ totalBytes: 48 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }),
    ).toBe(1)
    expect(
      chooseShardConcurrency({ totalBytes: 16 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 }),
    ).toBe(1)
  })

  test("bounds per-test timeout scaling under external CPU pressure", () => {
    // Low load still retains enough late-campaign headroom for a 60s internal
    // process deadline plus teardown; the former 60s outer ceiling raced it.
    expect(chooseShardTestTimeoutMs({ loadAverage1m: 12, cpuCount: 12 })).toBe(120_000)
    expect(chooseShardTestTimeoutMs({ loadAverage1m: 48, cpuCount: 12 })).toBe(240_000)
    expect(chooseShardTestTimeoutMs({ loadAverage1m: 300, cpuCount: 12 })).toBe(300_000)
    expect(chooseShardTestTimeoutMs({ loadAverage1m: Number.NaN, cpuCount: 12 })).toBe(120_000)
  })

  test("requires Bun's final executed-file receipt and ignores nested earlier footers", () => {
    const output = [
      "Ran 1 test across 1 file. [1ms]",
      "child output",
      "Ran 99 tests across 8 files. [20ms]",
    ].join("\n")
    expect(parseExecutedFileCount(output)).toBe(8)
    expect(parseExecutedFileCount("1 pass\n0 fail\n")).toBeUndefined()
  })
})

describe("scan-reach shard receipt", () => {
  test("merges unique worker sinks by minimum reach and writes the v1 receipt atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-receipt-test-"))
    temporaryDirectories.push(directory)
    const left = join(directory, "left.jsonl")
    const right = join(directory, "right.jsonl")
    const receiptPath = join(directory, "cache", "receipt.json")
    writeFileSync(left, '{"id":"b","walked":12,"matched":4}\n{"id":"a","walked":8}\n')
    writeFileSync(right, '{"id":"b","walked":10,"matched":3}\n')

    expect(mergeScanReachSinks([left, right])).toEqual([
      { id: "a", walked: 8 },
      { id: "b", walked: 10, matched: 3 },
    ])
    writeScanReachReceiptAtomic({
      path: receiptPath,
      head: "a".repeat(40),
      suite: "full",
      manifestSha256: "b".repeat(64),
      sinks: [left, right],
    })
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    expect(receipt.schema).toBe("quanta.scan-reach-receipt.v1")
    expect(receipt.childExit).toBe(0)
    expect(receipt.records).toEqual([
      { id: "a", walked: 8 },
      { id: "b", walked: 10, matched: 3 },
    ])
  })

  test("refuses malformed worker evidence instead of blessing a partial receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-receipt-test-"))
    temporaryDirectories.push(directory)
    const sink = join(directory, "bad.jsonl")
    writeFileSync(sink, '{"id":"scan","walked":-1}\n')
    expect(() => mergeScanReachSinks([sink])).toThrow("invalid scan-reach record")
  })
})

describe("same-HEAD successful shard cache", () => {
  test("normalizes runner-owned paths but keys every inherited test input", () => {
    const left = testEnvironmentSha256(
      { HOME: "/tmp/one", TMPDIR: "/tmp/a", QUANTA_MODE: "strict" },
      120_000,
    )
    const right = testEnvironmentSha256(
      { HOME: "/tmp/two", TMPDIR: "/tmp/b", QUANTA_MODE: "strict" },
      120_000,
    )
    expect(left).toBe(right)
    expect(testEnvironmentSha256({ QUANTA_MODE: "relaxed" }, 120_000)).not.toBe(left)
    expect(testEnvironmentSha256({ QUANTA_MODE: "strict" }, 240_000)).not.toBe(left)
  })

  test("hits only for an intact bounded exact-input receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-success-cache-test-"))
    temporaryDirectories.push(directory)
    const testFile = join(directory, "a.test.ts")
    const receiptPath = join(directory, "cache", "shard-1.json")
    writeFileSync(testFile, "test('a', () => expect(1).toBe(1))\n")
    const identity = {
      head: "a".repeat(40),
      suite: "full",
      manifestSha256: "b".repeat(64),
      shardIndex: 1,
      shardFileCount: 1,
      shardFilesSha256: shardFilesSha256(directory, [testFile]),
      toolchainSha256: "c".repeat(64),
      testEnvSha256: testEnvironmentSha256(
        { QUANTA_TEST_KNOB: "super-secret-cache-input" },
        120_000,
      ),
      junit: false,
    }
    const nowMs = 1_800_000_000_000
    writeSuccessfulTestShardReceiptAtomic({
      path: receiptPath,
      identity,
      executedFiles: 1,
      scanReachRecords: [{ id: "guard", walked: 4, matched: 2 }],
      nowMs,
    })

    expect(
      loadSuccessfulTestShardReceipt({ path: receiptPath, expected: identity, nowMs }).kind,
    ).toBe("hit")
    const identityMutations = [
      { ...identity, head: "d".repeat(40) },
      { ...identity, suite: "unit" },
      { ...identity, manifestSha256: "d".repeat(64) },
      { ...identity, shardIndex: 2 },
      { ...identity, shardFileCount: 2 },
      { ...identity, shardFilesSha256: "d".repeat(64) },
      { ...identity, toolchainSha256: "d".repeat(64) },
      { ...identity, testEnvSha256: "d".repeat(64) },
      { ...identity, junit: true },
    ]
    for (const expected of identityMutations) {
      expect(loadSuccessfulTestShardReceipt({ path: receiptPath, expected, nowMs })).toEqual({
        kind: "miss",
        reason: "input-mismatch",
      })
    }
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expected: identity,
        nowMs: nowMs + TEST_SHARD_CACHE_TTL_MS,
      }),
    ).toEqual({ kind: "miss", reason: "expired" })

    // Red-on-injection: changing a file changes the content identity even when
    // the path and overall manifest path digest stay fixed.
    writeFileSync(testFile, "test('a', () => expect(2).toBe(2))\n")
    expect(shardFilesSha256(directory, [testFile])).not.toBe(identity.shardFilesSha256)
    const raw = readFileSync(receiptPath, "utf8")
    expect(raw).not.toContain("super-secret-cache-input")
    const hit = loadSuccessfulTestShardReceipt({ path: receiptPath, expected: identity, nowMs })
    expect(hit.kind === "hit" ? hit.receipt.scanReachRecords : []).toEqual([
      { id: "guard", walked: 4, matched: 2 },
    ])
  })

  test("treats corrupt, tampered, and incomplete receipts as misses", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-success-cache-test-"))
    temporaryDirectories.push(directory)
    const receiptPath = join(directory, "shard.json")
    const identity = {
      head: "a".repeat(40),
      suite: "full",
      manifestSha256: "b".repeat(64),
      shardIndex: 1,
      shardFileCount: 1,
      shardFilesSha256: "c".repeat(64),
      toolchainSha256: "d".repeat(64),
      testEnvSha256: "e".repeat(64),
      junit: false,
    }
    writeFileSync(receiptPath, "not-json")
    expect(loadSuccessfulTestShardReceipt({ path: receiptPath, expected: identity })).toEqual({
      kind: "miss",
      reason: "absent-or-corrupt",
    })
    expect(() =>
      writeSuccessfulTestShardReceiptAtomic({
        path: receiptPath,
        identity,
        executedFiles: 0,
        scanReachRecords: [],
      }),
    ).toThrow("refusing to cache")

    writeSuccessfulTestShardReceiptAtomic({
      path: receiptPath,
      identity,
      executedFiles: 1,
      scanReachRecords: [],
    })
    const tampered = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    tampered.executedFiles = 2
    writeFileSync(receiptPath, JSON.stringify(tampered))
    expect(loadSuccessfulTestShardReceipt({ path: receiptPath, expected: identity })).toEqual({
      kind: "miss",
      reason: "integrity",
    })
  })
})
