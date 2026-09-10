/**
 * ★ HELLGATE — the shard cache survives a commit-id change with the same tree.
 *
 * MEASURED DEFECT (2026-09-02): `TestShardCacheIdentity` carried the git HEAD
 * sha, so EVERY commit invalidated EVERY chunk. Measured on a real run: 63
 * receipts on disk, `CACHE MISS reason=absent-or-corrupt` for all 31 chunks,
 * because the receipts were written under `754bbce0a`/`a4a02ad99` and HEAD had
 * moved to `ee18dd4de`. A docs-only commit — no test file, no source file
 * touched — threw away a 19-minute suite.
 *
 * HEAD was standing in for "the inputs changed". That is false across rebases,
 * cherry-picks, and metadata-only commits with byte-identical trees. The fix is
 * to bind the complete tracked tree by content and drop the commit-id proxy.
 *
 * Soundness is unchanged, and that is the point: a source edit invalidated
 * everything before (HEAD moved) and invalidates everything now (`treeSha256`
 * moves). Nothing became more permissive; what disappeared is the waste of
 * discarding receipts whose inputs are byte-identical.
 *
 * Tracked prose remains in the tree identity because ratchet tests read docs;
 * excluding it would trade cache hits for a false green.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadSuccessfulTestShardReceipt,
  type TestShardCacheIdentity,
  testShardCacheIdentitySha256,
  trackedTreeSha256,
  writeSuccessfulTestShardReceiptAtomic,
} from "../../tools/dev/test-shard-receipt"

const identity = (over: Partial<TestShardCacheIdentity> = {}): TestShardCacheIdentity => ({
  suite: "full",
  manifestSha256: "a".repeat(64),
  shardIndex: 3,
  shardFileCount: 2,
  shardFilesSha256: "b".repeat(64),
  toolchainSha256: "c".repeat(64),
  testEnvSha256: "d".repeat(64),
  treeSha256: "e".repeat(64),
  junit: false,
  intraParallel: 1,
  executionPolicySha256: "f".repeat(64),
  inputScopeSha256: "1".repeat(64),
  ...over,
})

const roundTrip = (
  written: TestShardCacheIdentity,
  expected: TestShardCacheIdentity,
): ReturnType<typeof loadSuccessfulTestShardReceipt> => {
  const dir = mkdtempSync(join(tmpdir(), "shard-cache-identity-"))
  try {
    const path = join(dir, "chunk.json")
    writeSuccessfulTestShardReceiptAtomic({
      path,
      identity: written,
      executedFiles: 2,
      scanReachRecords: [],
    })
    return loadSuccessfulTestShardReceipt({ path, expected })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("shard cache identity — what may and may not invalidate a receipt", () => {
  test("a receipt written for the same inputs is REUSED", () => {
    expect(roundTrip(identity(), identity()).kind).toBe("hit")
  })

  test("the git HEAD is NOT part of the identity — a commit alone cannot invalidate", () => {
    // There is no `head` field to differ on: the serialized receipt carries the
    // complete tracked-tree identity, so equal input trees still hit even when
    // their commits differ.
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-head-"))
    try {
      const path = join(dir, "chunk.json")
      writeSuccessfulTestShardReceiptAtomic({
        path,
        identity: identity(),
        executedFiles: 2,
        scanReachRecords: [],
      })
      const raw = Bun.file(path)
      expect(raw).toBeDefined()
      const parsed = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >
      expect(Object.keys(parsed)).not.toContain("head")
      expect(parsed.treeSha256).toBe("e".repeat(64))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a SOURCE change still invalidates — soundness is unchanged", () => {
    const lookup = roundTrip(identity(), identity({ treeSha256: "f".repeat(64) }))

    expect(lookup.kind).toBe("miss")
    if (lookup.kind === "miss") expect(lookup.reason).toBe("input-mismatch")
  })

  test("PAIRED CONTROL — every other identity field still invalidates", () => {
    const fields: readonly Partial<TestShardCacheIdentity>[] = [
      { suite: "unit" },
      { manifestSha256: "9".repeat(64) },
      { shardFileCount: 3 },
      { shardFilesSha256: "9".repeat(64) },
      { toolchainSha256: "9".repeat(64) },
      { testEnvSha256: "9".repeat(64) },
      { junit: true },
      { intraParallel: 8 },
      { executionPolicySha256: "9".repeat(64) },
      { inputScopeSha256: "9".repeat(64) },
    ]
    for (const over of fields) {
      expect(roundTrip(identity(), identity(over)).kind).toBe("miss")
      expect(testShardCacheIdentitySha256(identity(over))).not.toBe(
        testShardCacheIdentitySha256(identity()),
      )
    }
  })

  test("cache path identity ignores only the presentation ordinal", () => {
    expect(testShardCacheIdentitySha256(identity({ shardIndex: 99 }))).toBe(
      testShardCacheIdentitySha256(identity()),
    )
  })

  test("whole-tree identity includes tests outside the current chunk and tracked prose", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-tree-"))
    try {
      mkdirSync(join(dir, "tests", "unit"), { recursive: true })
      mkdirSync(join(dir, "docs"), { recursive: true })
      writeFileSync(join(dir, "tests", "unit", "a.test.ts"), "test('a', () => {})\n")
      writeFileSync(join(dir, "tests", "unit", "b.test.ts"), "test('b', () => {})\n")
      writeFileSync(join(dir, "docs", "note.md"), "one\n")
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      }
      git("init")
      git("config", "user.email", "cache-test@example.invalid")
      git("config", "user.name", "cache test")
      git("add", ".")
      git("commit", "-m", "base")
      const before = trackedTreeSha256(dir)

      writeFileSync(join(dir, "docs", "note.md"), "two\n")
      git("add", ".")
      git("commit", "-m", "prose")
      const afterProse = trackedTreeSha256(dir)
      expect(afterProse).not.toBe(before)

      writeFileSync(join(dir, "tests", "unit", "b.test.ts"), "test('changed', () => {})\n")
      git("add", ".")
      git("commit", "-m", "other-test")
      expect(trackedTreeSha256(dir)).not.toBe(afterProse)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("intraParallel is exact — concurrent green does not answer for serial", () => {
    expect(roundTrip(identity({ intraParallel: 8 }), identity({ intraParallel: 8 })).kind).toBe(
      "hit",
    )
    expect(roundTrip(identity({ intraParallel: 1 }), identity({ intraParallel: 1 })).kind).toBe(
      "hit",
    )
    expect(roundTrip(identity({ intraParallel: 8 }), identity({ intraParallel: 1 })).kind).toBe(
      "miss",
    )
    expect(roundTrip(identity({ intraParallel: 1 }), identity({ intraParallel: 8 })).kind).toBe(
      "miss",
    )
    expect(roundTrip(identity({ intraParallel: 2 }), identity({ intraParallel: 8 })).kind).toBe(
      "miss",
    )
  })

  test("v1 receipts are an explicit schema miss", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-v1-"))
    try {
      const path = join(dir, "chunk.json")
      writeFileSync(
        path,
        `${JSON.stringify({
          schema: "quanta.test-shard-success.v1",
          ...identity(),
          filesRunConcurrently: true,
          createdAtMs: 1,
          expiresAtMs: 1 + 24 * 60 * 60_000,
          executedFiles: 2,
          scanReachRecords: [],
          receiptSha256: "a".repeat(64),
        })}\n`,
      )
      expect(loadSuccessfulTestShardReceipt({ path, expected: identity(), nowMs: 2 }).kind).toBe(
        "miss",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("shardIndex still does NOT invalidate — a neighbour chunk may renumber it", () => {
    expect(roundTrip(identity(), identity({ shardIndex: 27 })).kind).toBe("hit")
  })

  test("a receipt whose src hash is malformed is REJECTED, not trusted", () => {
    // Without a schema check on this field a hand-edited or truncated receipt
    // could carry `treeSha256: ""` and then match any expectation that also
    // degraded — the field would be present but meaningless.
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-badsrc-"))
    try {
      const path = join(dir, "chunk.json")
      writeSuccessfulTestShardReceiptAtomic({
        path,
        identity: identity(),
        executedFiles: 2,
        scanReachRecords: [],
      })
      const fs = require("node:fs") as typeof import("node:fs")
      const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>
      parsed.treeSha256 = "not-a-sha"
      fs.writeFileSync(path, JSON.stringify(parsed))

      const lookup = loadSuccessfulTestShardReceipt({
        path,
        expected: identity({ treeSha256: "not-a-sha" as string }),
      })

      expect(lookup.kind).toBe("miss")
      if (lookup.kind === "miss") expect(lookup.reason).toBe("invalid-schema")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("ANTI-VACUITY — a corrupt receipt is a miss, so `hit` above is a real read", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-corrupt-"))
    try {
      const path = join(dir, "chunk.json")
      writeFileSync(path, "{ not json")
      expect(loadSuccessfulTestShardReceipt({ path, expected: identity() }).kind).toBe("miss")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
