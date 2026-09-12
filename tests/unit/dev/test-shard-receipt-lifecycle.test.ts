/**
 * ★ HELLGATE — receipt TTL collection and receipt/timing coherence.
 *
 * MEASURED DEFECTS (2026-09-12):
 *
 * - `pruneStaleChunkReceipts(suite)` cleaned `<root>/<suite>` — the BARE tier
 *   name — while tier caches are written under `full:pr` / `full:nightly`, so
 *   those namespaces were never collected by anything. Measured on this
 *   checkout's previous cache root: 307 receipts, 127 MiB, every one already
 *   expired, none collected.
 * - that prune ran only after every chunk went green, so a branch that keeps
 *   failing late accumulates the JUnit and scan payloads of the chunks that
 *   went green early, indefinitely.
 * - a shard could store a green receipt and then lose its timing write. The
 *   next campaign HIT that receipt, never re-ran the chunk, and never produced
 *   the timings — so `unit-speed-budget`, which refuses to pass without them,
 *   could not be satisfied by any number of retries.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  chunkCacheNamespace,
  loadSuccessfulTestShardReceipt,
  pruneExpiredShardReceipts,
  scanShardReceiptTimings,
  TEST_SHARD_CACHE_TTL_MS,
  type TestShardCacheIdentity,
  writeSuccessfulTestShardReceiptAtomic,
} from "../../../tools/dev/test-shard-receipt"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tvh05-lifecycle-"))
  roots.push(dir)
  return dir
}

const NOW = 1_800_000_000_000
const FILE_ID = "tests/unit/a.test.ts"

const JUNIT =
  '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="t">\n' +
  `<testsuite name="a" file="${FILE_ID}" tests="1" failures="0" time="0.25">\n` +
  `<testcase name="a" classname="a" time="0.25" file="${FILE_ID}" />\n` +
  "</testsuite>\n</testsuites>\n"

const identity = (over: Partial<TestShardCacheIdentity> = {}): TestShardCacheIdentity => ({
  scopeKind: "whole-tree",
  treeSha256: "a".repeat(64),
  suite: "full:pr",
  manifestSha256: "b".repeat(64),
  shardIndex: 1,
  shardFileCount: 1,
  shardFilesSha256: "c".repeat(64),
  runtimeSha256: "d".repeat(64),
  toolScopeSha256: "e".repeat(64),
  testEnvSha256: "f".repeat(64),
  junit: true,
  intraParallel: 1,
  executionPolicySha256: "0".repeat(64),
  timeoutPolicySha256: "1".repeat(64),
  inputScopeSha256: "2".repeat(64),
  producerReceiptsSha256: "3".repeat(64),
  ...over,
})

const observation = {
  file: FILE_ID,
  schedulingWeightMs: 250,
  suiteMs: 250,
  chunkOverheadShareMs: 0,
  observedChunkWallMs: 250,
  runnerClass: "pure",
  policyDigest: "policy",
  intraParallel: 1,
  loadPerCore: 0,
}

/** The one-file chunk `writeReceipt` files a green for. */
const EXECUTED = ["tests/unit/a.test.ts"] as const

const writeReceipt = (
  path: string,
  createdAtMs: number,
  over: Partial<TestShardCacheIdentity> = {},
): void => {
  writeSuccessfulTestShardReceiptAtomic({
    path,
    identity: identity(over),
    executedFileIds: [...EXECUTED],
    scanReachRecords: [],
    testTimeoutMs: 120_000,
    timingObservations: [observation],
    scopeReason: "fixture",
    junitXml: JUNIT,
    nowMs: createdAtMs,
  })
}

describe("expired receipts are collected in EVERY namespace the runner writes", () => {
  // Written as an invariant over whatever namespaces exist, not a pinned count:
  // the tier list grows under concurrent work.
  const NAMESPACES = ["full", "full:pr", "full:nightly", "unit", "certified"] as const
  const EXPIRED_PER_NAMESPACE = 3
  const LIVE_PER_NAMESPACE = 2

  test("every namespace is swept, and only expired receipts are removed", () => {
    const root = scratch()
    for (const namespace of NAMESPACES) {
      mkdirSync(join(root, namespace), { recursive: true })
      for (let index = 0; index < EXPIRED_PER_NAMESPACE; index += 1) {
        writeReceipt(join(root, namespace, `expired-${index}.json`), NOW - TEST_SHARD_CACHE_TTL_MS)
      }
      for (let index = 0; index < LIVE_PER_NAMESPACE; index += 1) {
        writeReceipt(join(root, namespace, `live-${index}.json`), NOW - 1_000)
      }
    }

    const report = pruneExpiredShardReceipts(root, NOW)

    expect([...report.namespaces].sort()).toEqual([...NAMESPACES].sort())
    expect(report.removed).toBe(NAMESPACES.length * EXPIRED_PER_NAMESPACE)
    expect(report.kept).toBe(NAMESPACES.length * LIVE_PER_NAMESPACE)
    expect(report.examined).toBe(report.removed + report.kept)
    expect(report.bytesReclaimed).toBeGreaterThan(0)
    for (const namespace of NAMESPACES) {
      expect(existsSync(join(root, namespace, "expired-0.json"))).toBe(false)
      // A live sibling worktree's receipt survives: TTL is the ONLY criterion.
      expect(existsSync(join(root, namespace, "live-0.json"))).toBe(true)
    }
  })

  test("the namespace a tiered identity writes to is one the sweep covers", () => {
    // WIRING PROOF. The old prune took the bare suite name while the writer
    // used `suite:tier`, so the two never met. This asserts they agree.
    const root = scratch()
    const tiered = identity({ suite: "full:nightly" })
    const certified = identity({ scopeKind: "certified" })
    expect(chunkCacheNamespace(tiered)).toBe("full:nightly")
    expect(chunkCacheNamespace(certified)).toBe("certified")

    for (const namespace of [chunkCacheNamespace(tiered), chunkCacheNamespace(certified)]) {
      mkdirSync(join(root, namespace), { recursive: true })
      writeReceipt(join(root, namespace, "chunk.json"), NOW - TEST_SHARD_CACHE_TTL_MS)
    }

    const report = pruneExpiredShardReceipts(root, NOW)

    expect(report.removed).toBe(2)
    expect([...report.namespaces].sort()).toEqual(["certified", "full:nightly"])
  })

  test("an unreadable receipt is collected, and an absent root is not an error", () => {
    const root = scratch()
    mkdirSync(join(root, "full"), { recursive: true })
    writeFileSync(join(root, "full", "torn.json"), "{ half-written")
    expect(pruneExpiredShardReceipts(root, NOW).removed).toBe(1)
    expect(pruneExpiredShardReceipts(join(root, "nope"), NOW)).toMatchObject({
      removed: 0,
      examined: 0,
    })
  })
})

describe("a green receipt and its timings cannot disagree", () => {
  test("a receipt that cannot rehydrate its timings is REFUSED at write", () => {
    const root = scratch()
    expect(() =>
      writeSuccessfulTestShardReceiptAtomic({
        path: join(root, "chunk.json"),
        identity: identity({ shardFileCount: 2 }),
        executedFileIds: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"],
        scanReachRecords: [],
        testTimeoutMs: 120_000,
        timingObservations: [observation],
        scopeReason: "fixture",
        junitXml: JUNIT,
        nowMs: NOW,
      }),
    ).toThrow("incoherent receipt")
    expect(existsSync(join(root, "chunk.json"))).toBe(false)
  })

  test("an already-incoherent receipt is a BOUNDED miss, not a permanent hit", () => {
    const root = scratch()
    const path = join(root, "chunk.json")
    writeReceipt(path, NOW)
    // The exact historical state: green receipt on disk, timing write lost.
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    parsed.timingObservations = []
    const { receiptSha256: _drop, ...payload } = parsed
    parsed.receiptSha256 = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
    writeFileSync(path, JSON.stringify(parsed))

    const lookup = loadSuccessfulTestShardReceipt({
      path,
      expected: identity(),
      expectedTestTimeoutMs: 120_000,
      expectedFileIds: [...EXECUTED],
      nowMs: NOW + 1,
    })

    expect(lookup.kind).toBe("miss")
    if (lookup.kind === "miss") expect(lookup.reason).toBe("timing-incoherent:0/1")
    // BOUNDED: re-running the chunk writes a receipt that carries the
    // observations, and that one hits. The miss cannot repeat forever.
    writeReceipt(path, NOW)
    expect(
      loadSuccessfulTestShardReceipt({
        path,
        expected: identity(),
        expectedTestTimeoutMs: 120_000,
        expectedFileIds: [...EXECUTED],
        nowMs: NOW + 1,
      }).kind,
    ).toBe("hit")
  })

  test("a cache hit carries the per-file observations the store needs", () => {
    const root = scratch()
    const path = join(root, "chunk.json")
    writeReceipt(path, NOW)

    const lookup = loadSuccessfulTestShardReceipt({
      path,
      expected: identity(),
      expectedTestTimeoutMs: 120_000,
      expectedFileIds: [...EXECUTED],
      nowMs: NOW + 1,
    })

    expect(lookup.kind).toBe("hit")
    if (lookup.kind !== "hit") return
    expect(lookup.receipt.timingObservations).toEqual([observation])
    // And the receipt's OWN creation time is the sample time, so a replayed
    // measurement ages out exactly like the one it replays.
    expect(lookup.receipt.createdAtMs).toBe(NOW)
    expect(lookup.receipt.maxObservedCaseMs).toBe(250)
  })

  test("bounded recovery finds the wanted files and stops", () => {
    const root = scratch()
    mkdirSync(join(root, "full:pr"), { recursive: true })
    for (let index = 0; index < 5; index += 1) {
      writeReceipt(join(root, "full:pr", `chunk-${index}.json`), NOW)
    }

    const scan = scanShardReceiptTimings(root, new Set([FILE_ID]), NOW + 1)

    expect(scan.recovered).toBe(1)
    expect(scan.timings.get(FILE_ID)).toBe(250)
    // It stopped after the first receipt that satisfied the request.
    expect(scan.receiptsAvailable).toBe(5)
    expect(scan.receiptsRead).toBe(1)
  })

  test("ANTI-VACUITY — a file no receipt covers is reported as not recovered", () => {
    const root = scratch()
    mkdirSync(join(root, "full"), { recursive: true })
    writeReceipt(join(root, "full", "chunk.json"), NOW)

    const scan = scanShardReceiptTimings(root, new Set(["tests/unit/never-ran.test.ts"]), NOW + 1)

    expect(scan.recovered).toBe(0)
    expect(scan.receiptsRead).toBe(1)
  })
})
