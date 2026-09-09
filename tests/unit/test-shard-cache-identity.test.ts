/**
 * ★ HELLGATE — the shard cache survives a commit that cannot change a verdict.
 *
 * MEASURED DEFECT (2026-09-02): `TestShardCacheIdentity` carried the git HEAD
 * sha, so EVERY commit invalidated EVERY chunk. Measured on a real run: 63
 * receipts on disk, `CACHE MISS reason=absent-or-corrupt` for all 31 chunks,
 * because the receipts were written under `754bbce0a`/`a4a02ad99` and HEAD had
 * moved to `ee18dd4de`. A docs-only commit — no test file, no source file
 * touched — threw away a 19-minute suite.
 *
 * HEAD was standing in for "the code under test changed", which the identity
 * otherwise could not see: `shardFilesSha256` hashes the chunk's own TEST files
 * and `manifestSha256` hashes only the file-path list. So the fix is to name the
 * real dependency — a content hash of `src`/`tools` — and drop the proxy.
 *
 * Soundness is unchanged, and that is the point: a source edit invalidated
 * everything before (HEAD moved) and invalidates everything now (`treeSha256`
 * moves). Nothing became more permissive; what disappeared is the waste of
 * discarding receipts whose inputs are byte-identical.
 *
 * Of 30 commits sampled from the day this was found: 18 touched src/tools, 9
 * were tests-only, 3 were docs-only. Under HEAD-keying all 30 cost a full run.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadSuccessfulTestShardReceipt,
  type TestShardCacheIdentity,
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
    // The whole defect: a docs-only commit moved HEAD and discarded 31 chunks.
    // There is no `head` field to differ on, so this is expressed as: the
    // serialized receipt carries no head, and identical inputs still hit.
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
