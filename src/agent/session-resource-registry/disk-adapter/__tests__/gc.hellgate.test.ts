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
import { sweepDiskRegistry } from "../gc"
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
