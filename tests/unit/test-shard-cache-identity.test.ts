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
 * everything before (HEAD moved) and invalidates everything now (`srcSha256`
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
  srcSha256: "e".repeat(64),
  junit: false,
  filesRunConcurrently: false,
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
      expect(parsed.srcSha256).toBe("e".repeat(64))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a SOURCE change still invalidates — soundness is unchanged", () => {
    const lookup = roundTrip(identity(), identity({ srcSha256: "f".repeat(64) }))

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
    ]
    for (const over of fields) {
      expect(roundTrip(identity(), identity(over)).kind).toBe("miss")
    }
  })

  test("a concurrent green answers for a serial plan, but never the reverse", () => {
    // IMPLICATION, not equality. Running a chunk's files concurrently is the
    // strictly harder condition — it is the one that can interleave shared
    // module state — so that green also covers a serial plan. A serial green
    // covers only serial: without this the cache had a blind spot where a
    // loaded box banked serial receipts and an idle box, planning `pure`
    // chunks concurrently, HIT them and never exercised the interleaving.
    expect(
      roundTrip(identity({ filesRunConcurrently: true }), identity({ filesRunConcurrently: true }))
        .kind,
    ).toBe("hit")
    expect(
      roundTrip(identity({ filesRunConcurrently: true }), identity({ filesRunConcurrently: false }))
        .kind,
    ).toBe("hit")
    expect(
      roundTrip(
        identity({ filesRunConcurrently: false }),
        identity({ filesRunConcurrently: false }),
      ).kind,
    ).toBe("hit")
    const blindSpot = roundTrip(
      identity({ filesRunConcurrently: false }),
      identity({ filesRunConcurrently: true }),
    )
    expect(blindSpot.kind).toBe("miss")
    if (blindSpot.kind === "miss") expect(blindSpot.reason).toBe("input-mismatch")
  })

  test("shardIndex still does NOT invalidate — a neighbour chunk may renumber it", () => {
    expect(roundTrip(identity(), identity({ shardIndex: 27 })).kind).toBe("hit")
  })

  test("a receipt whose src hash is malformed is REJECTED, not trusted", () => {
    // Without a schema check on this field a hand-edited or truncated receipt
    // could carry `srcSha256: ""` and then match any expectation that also
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
      parsed.srcSha256 = "not-a-sha"
      fs.writeFileSync(path, JSON.stringify(parsed))

      const lookup = loadSuccessfulTestShardReceipt({
        path,
        expected: identity({ srcSha256: "not-a-sha" as string }),
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
