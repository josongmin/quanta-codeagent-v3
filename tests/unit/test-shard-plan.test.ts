import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertTestShardPlan,
  chooseShardConcurrency,
  createTestShardPlan,
  parseExecutedFileCount,
  usesSharedTestResource,
} from "../../tools/dev/test-shard-plan"
import {
  mergeScanReachSinks,
  writeScanReachReceiptAtomic,
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
