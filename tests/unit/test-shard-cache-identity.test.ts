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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executedFileSetDigest } from "../../tools/dev/executed-file-set"
import {
  loadSuccessfulTestShardReceipt,
  type TestShardCacheIdentity,
  testShardCacheIdentitySha256,
  trackedTreeSha256,
  writeSuccessfulTestShardReceiptAtomic,
} from "../../tools/dev/test-shard-receipt"

const identity = (over: Partial<TestShardCacheIdentity> = {}): TestShardCacheIdentity => ({
  scopeKind: "whole-tree",
  suite: "full",
  manifestSha256: "a".repeat(64),
  shardIndex: 3,
  shardFileCount: 2,
  shardFilesSha256: "b".repeat(64),
  runtimeSha256: "9".repeat(64),
  toolScopeSha256: "c".repeat(64),
  testEnvSha256: "d".repeat(64),
  treeSha256: "e".repeat(64),
  junit: false,
  intraParallel: 1,
  executionPolicySha256: "f".repeat(64),
  inputScopeSha256: "1".repeat(64),
  timeoutPolicySha256: "2".repeat(64),
  producerReceiptsSha256: "3".repeat(64),
  ...over,
})

/** The chunk every helper in this file is asking about. */
const PLANNED = ["tests/unit/a.test.ts", "tests/unit/b.test.ts"] as const

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
      executedFileIds: [...PLANNED],
      scanReachRecords: [],
      testTimeoutMs: 120_000,
      timingObservations: [],
      scopeReason: "test",
    })
    return loadSuccessfulTestShardReceipt({
      path,
      expected,
      expectedTestTimeoutMs: 120_000,
      expectedFileIds: [...PLANNED],
    })
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
        executedFileIds: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"],
        scanReachRecords: [],
        testTimeoutMs: 120_000,
        timingObservations: [],
        scopeReason: "test",
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
      { runtimeSha256: "8".repeat(64) },
      { toolScopeSha256: "9".repeat(64) },
      { timeoutPolicySha256: "9".repeat(64) },
      { producerReceiptsSha256: "9".repeat(64) },
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
          executedFileIds: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"],
          scanReachRecords: [],
          receiptSha256: "a".repeat(64),
        })}\n`,
      )
      expect(
        loadSuccessfulTestShardReceipt({
          path,
          expected: identity(),
          expectedTestTimeoutMs: 120_000,
          expectedFileIds: [...PLANNED],
          nowMs: 2,
        }).kind,
      ).toBe("miss")
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
        executedFileIds: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"],
        scanReachRecords: [],
        testTimeoutMs: 120_000,
        timingObservations: [],
        scopeReason: "test",
      })
      const fs = require("node:fs") as typeof import("node:fs")
      const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>
      parsed.treeSha256 = "not-a-sha"
      fs.writeFileSync(path, JSON.stringify(parsed))

      const lookup = loadSuccessfulTestShardReceipt({
        path,
        expected: identity({ treeSha256: "not-a-sha" as string }),
        expectedTestTimeoutMs: 120_000,
        expectedFileIds: [...PLANNED],
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
      expect(
        loadSuccessfulTestShardReceipt({
          path,
          expected: identity(),
          expectedTestTimeoutMs: 120_000,
          expectedFileIds: [...PLANNED],
        }).kind,
      ).toBe("miss")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * A cache HIT restores a VERDICT. Until v4 it restored a COUNT.
 *
 * `executedFiles: number` meant a reused receipt asserted "146 files ran" —
 * satisfied by 146 of somebody else's files, because the receipt recorded the
 * plan and never the execution. The schema now carries the ids and a digest
 * OF those ids, so a hit can be re-checked instead of trusted.
 */
describe("cache hit restores the executed SET", () => {
  const FILES = ["tests/unit/a.test.ts", "tests/unit/b.test.ts"] as const

  /**
   * Two tamper modes, because the receipt has two layers and they catch
   * different attacks.
   *
   * `tamper` edits the JSON and leaves `receiptSha256` alone: the integrity
   * signature catches it, and the reason is `integrity`. That layer already
   * existed and these tests must not claim credit for it.
   *
   * `remint` edits the JSON and RE-SIGNS it, which is what a writer with a
   * regression produces — a receipt that describes an execution that did not
   * happen. Only the executed-set checks see that one, so it is the shape worth
   * pinning.
   *
   * A re-signed receipt has TWO degrees of freedom, and an audit caught this
   * helper conflating them: overriding `executedFileIds` alone leaves the
   * digest stale, so the loader's SELF-consistency check fires and the arm
   * never reaches the check that compares the receipt to the caller's chunk.
   * `remint` therefore re-derives the digest from the ids it just wrote — the
   * receipt really is internally consistent — and a caller that wants the
   * stale-digest shape passes `executedDigestSha256` explicitly.
   */
  const resign = (row: Record<string, unknown>): Record<string, unknown> => {
    const { receiptSha256: _drop, ...body } = row
    return { ...body, receiptSha256: Bun.CryptoHasher.hash("sha256", JSON.stringify(body), "hex") }
  }

  const write = (
    dir: string,
    overrides: Record<string, unknown> = {},
    mode: "tamper" | "remint" = "remint",
  ): string => {
    const path = join(dir, "chunk.json")
    writeSuccessfulTestShardReceiptAtomic({
      path,
      identity: identity(),
      executedFileIds: [...FILES],
      scanReachRecords: [],
      testTimeoutMs: 120_000,
      timingObservations: [],
      scopeReason: "test",
    })
    if (Object.keys(overrides).length > 0) {
      const row = {
        ...(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>),
        ...overrides,
      }
      if (
        mode === "remint" &&
        Array.isArray(row.executedFileIds) &&
        overrides.executedDigestSha256 === undefined
      ) {
        row.executedDigestSha256 = executedFileSetDigest(row.executedFileIds as string[])
      }
      writeFileSync(path, JSON.stringify(mode === "remint" ? resign(row) : row))
    }
    return path
  }

  const load = (path: string) =>
    loadSuccessfulTestShardReceipt({
      path,
      expected: identity(),
      expectedTestTimeoutMs: 120_000,
      // The chunk the CALLER planned. Every arm below tampers with what the
      // receipt says was executed; this is the fixed thing it is compared to.
      expectedFileIds: [...FILES],
    })

  test("a hit carries the ids and a digest that matches them", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-set-"))
    try {
      const hit = load(write(dir))
      expect(hit.kind).toBe("hit")
      if (hit.kind !== "hit") throw new Error("unreachable")
      expect(hit.receipt.executedFileIds).toEqual([...FILES])
      expect(hit.receipt.executedDigestSha256).toBe(executedFileSetDigest([...FILES]))
      expect(hit.receipt.executedDigestSha256).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an untouched receipt still verifies after a re-sign — the harness is honest", () => {
    // ANTI-VACUITY for every `remint` arm below: if re-signing did not produce
    // a receipt the loader accepts, those arms would be testing the harness.
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-resign-"))
    try {
      expect(load(write(dir, { scopeReason: "test" })).kind).toBe("hit")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an edit WITHOUT re-signing is caught by the integrity layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-integrity-"))
    try {
      const miss = load(write(dir, { executedFileIds: ["tests/unit/x.test.ts"] }, "tamper"))
      expect(miss.kind).toBe("miss")
      if (miss.kind !== "miss") throw new Error("unreachable")
      expect(miss.reason).toBe("integrity")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SUBSTITUTION at the same count is a MISS, where v3 was a hit", () => {
    // The whole defect, at the cache layer: two ids, two ids, neither planned.
    //
    // MEASURED before the caller check existed: this exact receipt — ids
    // swapped, digest recomputed over the swapped ids, re-signed, so every
    // check the loader had compared the receipt only to itself — returned
    // `hit` and the runner skipped the chunk.
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-sub-"))
    try {
      const swapped = ["tests/unit/x.test.ts", "tests/unit/y.test.ts"]
      expect(swapped.length).toBe(FILES.length) // a count check sees no problem
      const path = write(dir, { executedFileIds: swapped })
      // The receipt is INTERNALLY sound: count, digest and signature all agree.
      const row = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      expect(row.executedFileIds).toEqual(swapped)
      expect(row.executedDigestSha256).toBe(executedFileSetDigest(swapped))
      const miss = load(path)
      // ...and it still misses, because it is not THIS chunk's green.
      expect(miss.kind).toBe("miss")
      if (miss.kind !== "miss") throw new Error("unreachable")
      expect(miss.reason).toBe("executed-set-not-this-chunk")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a HALF-fixed writer — ids swapped, digest left stale — is the other miss", () => {
    // Distinct from the arm above and from `tamper`: the signature is valid,
    // so the integrity layer is silent, and the two executed-set checks are
    // reached in order. Naming both reasons is what stops either check from
    // being deleted while the suite stays green.
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-sub-stale-"))
    try {
      const swapped = ["tests/unit/x.test.ts", "tests/unit/y.test.ts"]
      const path = write(dir, {
        executedFileIds: swapped,
        executedDigestSha256: executedFileSetDigest([...FILES]),
      })
      const row = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      expect(row.executedDigestSha256).not.toBe(executedFileSetDigest(swapped))
      const miss = load(path)
      expect(miss.kind).toBe("miss")
      if (miss.kind !== "miss") throw new Error("unreachable")
      expect(miss.reason).toBe("executed-digest-mismatch")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the caller's own chunk is what a hit is checked against, both ways", () => {
    // PAIRED CONTROL for the check above: an honest receipt misses when the
    // CALLER asks about a different chunk, so `executed-set-not-this-chunk` is
    // not a property of tampered receipts — it is a comparison.
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-caller-"))
    try {
      const path = write(dir)
      expect(load(path).kind).toBe("hit")
      const other = loadSuccessfulTestShardReceipt({
        path,
        expected: identity(),
        expectedTestTimeoutMs: 120_000,
        expectedFileIds: ["tests/unit/a.test.ts", "tests/unit/c.test.ts"],
      })
      expect(other.kind).toBe("miss")
      if (other.kind !== "miss") throw new Error("unreachable")
      expect(other.reason).toBe("executed-set-not-this-chunk")
      // ORDER, not just membership: the digest is over the set as recorded, and
      // a reordered ask must not be treated as a different chunk.
      const reordered = loadSuccessfulTestShardReceipt({
        path,
        expected: identity(),
        expectedTestTimeoutMs: 120_000,
        expectedFileIds: [...FILES].reverse(),
      })
      expect(reordered.kind).toBe("hit")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a forged digest over the RIGHT ids is still a miss", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-forge-"))
    try {
      const miss = load(write(dir, { executedDigestSha256: "9".repeat(64) }))
      expect(miss.kind).toBe("miss")
      if (miss.kind !== "miss") throw new Error("unreachable")
      expect(miss.reason).toBe("executed-digest-mismatch")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("dropping a file is a discovery miss, named as one", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-drop-"))
    try {
      const miss = load(
        write(dir, {
          executedFileIds: ["tests/unit/a.test.ts"],
          executedDigestSha256: executedFileSetDigest(["tests/unit/a.test.ts"]),
        }),
      )
      expect(miss.kind).toBe("miss")
      if (miss.kind !== "miss") throw new Error("unreachable")
      expect(miss.reason).toBe("discovery-mismatch")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a v3 receipt cannot be read as a v4 proof", () => {
    // Old receipts carry a count and no ids. They must MISS, not be coerced
    // into a set-shaped claim they never made.
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-v3-"))
    try {
      const path = write(dir)
      const row = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      delete row.executedFileIds
      delete row.executedDigestSha256
      writeFileSync(
        path,
        JSON.stringify({ ...row, schema: "quanta.test-shard-success.v3", executedFiles: 2 }),
      )
      expect(load(path).kind).toBe("miss")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the writer refuses a set that disagrees with the identity it is filed under", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-cache-refuse-"))
    try {
      const path = join(dir, "chunk.json")
      const base = {
        path,
        identity: identity(),
        scanReachRecords: [],
        testTimeoutMs: 120_000,
        timingObservations: [],
        scopeReason: "test",
      } as const
      // shardFileCount is 2 for `identity()`.
      expect(() =>
        writeSuccessfulTestShardReceiptAtomic({
          ...base,
          executedFileIds: ["tests/unit/a.test.ts"],
        }),
      ).toThrow("refusing to cache")
      // ...and a set padded to the right LENGTH by repeating one id.
      expect(() =>
        writeSuccessfulTestShardReceiptAtomic({
          ...base,
          executedFileIds: ["tests/unit/a.test.ts", "tests/unit/a.test.ts"],
        }),
      ).toThrow("refusing to cache")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
