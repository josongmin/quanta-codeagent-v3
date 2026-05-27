/**
 * ADR-0348 — GC hellgate.
 *
 * Coverage:
 *   A. expired session (lastTouched < now-ttl) ⇒ evicted        (1)
 *   B. non-expired ⇒ preserved                                  (1)
 *   C. oversize jsonl ⇒ truncated from front                    (1)
 *   D. missing storageDir ⇒ {0,0}, NO-THROW                     (1)
 *   E. malformed meta.json ⇒ skip TTL eviction (preserve)       (1)
 *   F. mixed (expired + oversize + healthy) handled in one pass (1)
 *   G. default TTL is 14 days; default size is 50MB             (1)
 *   H. permission error inside storageDir ⇒ swallow             (1)
 *
 *  Total = 8 cases.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countDiskRegistryCleanupCandidates, sweepDiskRegistry } from "../gc"
import { DEFAULT_MAX_SESSION_BYTES, DEFAULT_TTL_MS } from "../types"

const tempStorage = async (): Promise<string> => mkdtemp(join(tmpdir(), "adr0348-gc-"))

const writeSession = async (
  root: string,
  id: string,
  opts: { lastTouched: number; eventsBody?: string; cacheBody?: string },
): Promise<string> => {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ sessionId: id, lastTouched: opts.lastTouched }),
    "utf8",
  )
  if (opts.eventsBody !== undefined) {
    await writeFile(join(dir, "events.jsonl"), opts.eventsBody, "utf8")
  }
  if (opts.cacheBody !== undefined) {
    await writeFile(join(dir, "prompt-cache.jsonl"), opts.cacheBody, "utf8")
  }
  return dir
}

const dirExists = async (path: string): Promise<boolean> => {
  try {
    const st = await stat(path)
    return st.isDirectory()
  } catch {
    return false
  }
}

describe("ADR-0348-gc §A — expired session evicted", () => {
  test("ttlMs sweep removes old session dir", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    // expired: lastTouched 1 hour before now, ttl 1 minute
    await writeSession(root, "old", { lastTouched: now - 60 * 60 * 1000 })
    const res = await sweepDiskRegistry({ storageDir: root, ttlMs: 60_000, now: () => now })
    expect(res.evicted).toBe(1)
    expect(await dirExists(join(root, "old"))).toBe(false)
  })
})

describe("ADR-0348-gc §B — non-expired preserved", () => {
  test("recent session is left alone", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    await writeSession(root, "fresh", { lastTouched: now - 100 })
    const res = await sweepDiskRegistry({ storageDir: root, ttlMs: 60_000, now: () => now })
    expect(res.evicted).toBe(0)
    expect(await dirExists(join(root, "fresh"))).toBe(true)
  })
})

describe("ADR-0348-gc §C — oversize jsonl truncated from front", () => {
  test("events.jsonl shrinks below cap", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    const big = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ kind: "context_update", field: "cwd", prev: "a", next: "b", at: i }),
    ).join("\n")
    await writeSession(root, "big", {
      lastTouched: now,
      eventsBody: big,
    })
    const cap = 500
    const res = await sweepDiskRegistry({
      storageDir: root,
      ttlMs: DEFAULT_TTL_MS,
      maxSessionBytes: cap,
      now: () => now,
    })
    expect(res.truncated).toBe(1)
    const afterBody = await readFile(join(root, "big", "events.jsonl"), "utf8")
    expect(Buffer.byteLength(afterBody, "utf8")).toBeLessThanOrEqual(cap)
    // At least one record survives.
    expect(afterBody.length).toBeGreaterThan(0)
  })
})

describe("ADR-0348-gc §D — missing storageDir ⇒ {0,0}", () => {
  test("non-existent dir is no-op", async () => {
    const res = await sweepDiskRegistry({
      storageDir: "/no/such/path/for/adr0348/gc/test",
    })
    expect(res).toEqual({ evicted: 0, truncated: 0 })
  })
})

describe("ADR-0348-gc §E — malformed meta.json skipped on TTL", () => {
  test("session with bad meta is NOT evicted (no signal to evict on)", async () => {
    const root = await tempStorage()
    const dir = join(root, "no-meta")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "meta.json"), "{garbage", "utf8")
    const res = await sweepDiskRegistry({
      storageDir: root,
      ttlMs: 1,
      now: () => Number.MAX_SAFE_INTEGER,
    })
    expect(res.evicted).toBe(0)
    expect(await dirExists(dir)).toBe(true)
  })
})

describe("ADR-0348-gc §F — mixed pass handles all axes", () => {
  test("expired + oversize + healthy in one sweep", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    await writeSession(root, "expired", { lastTouched: now - 10_000_000 })
    const big = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ kind: "context_update", field: "cwd", prev: "a", next: "b", at: i }),
    ).join("\n")
    await writeSession(root, "oversize", { lastTouched: now, eventsBody: big })
    await writeSession(root, "healthy", { lastTouched: now })
    const res = await sweepDiskRegistry({
      storageDir: root,
      ttlMs: 60_000,
      maxSessionBytes: 500,
      now: () => now,
    })
    expect(res.evicted).toBe(1)
    expect(res.truncated).toBeGreaterThanOrEqual(1)
    expect(await dirExists(join(root, "expired"))).toBe(false)
    expect(await dirExists(join(root, "healthy"))).toBe(true)
    expect(await dirExists(join(root, "oversize"))).toBe(true)
  })
})

describe("ADR-0348-gc §G — default TTL + size constants", () => {
  test("defaults align with ADR-0348 §Tradeoffs", () => {
    expect(DEFAULT_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000)
    expect(DEFAULT_MAX_SESSION_BYTES).toBe(50_000_000)
  })
})

describe("ADR-0348-gc §H — permission / corrupt subentry swallowed", () => {
  test("file-not-a-directory entry inside storageDir is skipped", async () => {
    const root = await tempStorage()
    // Place a regular file at the top level of storageDir. The sweeper
    // must skip it (not a directory) without throwing.
    await writeFile(join(root, "stray-file.txt"), "hello", "utf8")
    await writeSession(root, "alive", { lastTouched: Date.now() })
    const res = await sweepDiskRegistry({ storageDir: root, ttlMs: DEFAULT_TTL_MS })
    expect(res.evicted).toBe(0)
    expect(res.truncated).toBe(0)
    // The healthy session remains
    expect(await dirExists(join(root, "alive"))).toBe(true)
    // The stray file remains too
    const stray = await readFile(join(root, "stray-file.txt"), "utf8")
    expect(stray).toBe("hello")
  })
})

// ─── ADR-0387 — countDiskRegistryCleanupCandidates (dry-run) ──────────────
//
// 5 cases. Same axes as sweepDiskRegistry (TTL + size cap) but using
// SELECT/scan-only semantics: NO fs mutation (no unlink, no writeFile).
// The function returns the candidate count so an operator can preview
// `cleanup --dry-run` output without committing the sweep.
describe("ADR-0387 countDiskRegistryCleanupCandidates — hellgate", () => {
  test("[1] empty dir ⇒ wouldEvict 0 / inspectedSessions 0", async () => {
    const root = await tempStorage()
    const res = await countDiskRegistryCleanupCandidates({ storageDir: root })
    expect(res.wouldEvictByTtl).toBe(0)
    expect(res.wouldEvictBySize).toBe(0)
    expect(res.inspectedSessions).toBe(0)
    expect(res.storageDir).toBe(root)
  })

  test("[2] TTL candidates counted correctly", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    // 2 expired, 1 fresh
    await writeSession(root, "old-a", { lastTouched: now - 60 * 60 * 1000 })
    await writeSession(root, "old-b", { lastTouched: now - 60 * 60 * 1000 })
    await writeSession(root, "fresh", { lastTouched: now - 100 })
    const res = await countDiskRegistryCleanupCandidates({
      storageDir: root,
      ttlMs: 60_000,
      now: () => now,
    })
    expect(res.wouldEvictByTtl).toBe(2)
    expect(res.inspectedSessions).toBe(3)
    // No fs changes: all three dirs still exist
    expect(await dirExists(join(root, "old-a"))).toBe(true)
    expect(await dirExists(join(root, "old-b"))).toBe(true)
    expect(await dirExists(join(root, "fresh"))).toBe(true)
  })

  test("[3] size-cap candidates counted (oversize ⇒ wouldEvictBySize >= 1)", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    const big = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ kind: "context_update", field: "cwd", prev: "a", next: "b", at: i }),
    ).join("\n")
    await writeSession(root, "big", { lastTouched: now, eventsBody: big })
    await writeSession(root, "small", { lastTouched: now, eventsBody: "{}" })
    const res = await countDiskRegistryCleanupCandidates({
      storageDir: root,
      ttlMs: DEFAULT_TTL_MS,
      maxSessionBytes: 500,
      now: () => now,
    })
    expect(res.wouldEvictBySize).toBe(1)
    expect(res.wouldEvictByTtl).toBe(0)
    expect(res.inspectedSessions).toBe(2)
    // Idempotent: bytes on disk unchanged
    const stillBig = await readFile(join(root, "big", "events.jsonl"), "utf8")
    expect(Buffer.byteLength(stillBig, "utf8")).toBe(Buffer.byteLength(big, "utf8"))
  })

  test("[4] missing storageDir ⇒ zero values, NO-THROW", async () => {
    const res = await countDiskRegistryCleanupCandidates({
      storageDir: "/no/such/dir/for/adr0387/dry-run",
    })
    expect(res.wouldEvictByTtl).toBe(0)
    expect(res.wouldEvictBySize).toBe(0)
    expect(res.inspectedSessions).toBe(0)
    expect(res.storageDir).toBe("/no/such/dir/for/adr0387/dry-run")
  })

  test("[5] idempotent — second call sees identical state (no fs mutation)", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    await writeSession(root, "expired", { lastTouched: now - 10_000_000 })
    await writeSession(root, "fresh", { lastTouched: now })
    const res1 = await countDiskRegistryCleanupCandidates({
      storageDir: root,
      ttlMs: 60_000,
      now: () => now,
    })
    const res2 = await countDiskRegistryCleanupCandidates({
      storageDir: root,
      ttlMs: 60_000,
      now: () => now,
    })
    // The two calls return identical results (no mutation between them).
    expect(res2.wouldEvictByTtl).toBe(res1.wouldEvictByTtl)
    expect(res2.inspectedSessions).toBe(res1.inspectedSessions)
    // And the expired session is STILL on disk (count, not sweep).
    expect(await dirExists(join(root, "expired"))).toBe(true)
    expect(await dirExists(join(root, "fresh"))).toBe(true)
  })
})
