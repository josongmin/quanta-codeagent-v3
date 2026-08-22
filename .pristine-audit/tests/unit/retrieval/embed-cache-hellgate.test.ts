/**
 * HELLGATE — adversarial proofs for ADR-0263 EmbedCache.
 *
 * Invariants:
 *   (i)   put/get is idempotent — same (text, modelTag) always returns the
 *         exact same vector (no float drift, no re-quantisation);
 *   (ii)  modelTag is part of the key — provider/model swap invalidates
 *         every entry tagged with the old modelTag and NEVER returns a
 *         cross-model false hit;
 *   (iii) capacity is bounded — LRU evicts oldest at the cap, never grows
 *         past N entries;
 *   (iv)  invalidate(modelTag) wipes ONLY that tag's entries;
 *   (v)   sqlite adapter persists across reload, expires entries past TTL,
 *         creates the file with mode 0600;
 *   (vi)  the `none` adapter is byte-identical to "no cache" — every get
 *         returns null, every put is a no-op, size stays at 0;
 *   (vii) modelTag canonical format is enforced (`{provider}-{model}-v{version}-d{dim}`).
 *
 * 15 adversarial cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type EmbedCache,
  type EmbedCacheHit,
  hashText,
  isCanonicalModelTag,
  makeCacheKey,
  newInMemoryEmbedCache,
  newNoneEmbedCache,
  newSqliteEmbedCache,
  resolveEmbedCacheFromEnv,
} from "@/retrieval/cache"

const MODEL_A = "openai-text-embedding-3-small-v1-d1536"
const MODEL_B = "voyage-voyage-3-v1-d1024"

describe("EmbedCache hellgate (15 cases)", () => {
  // ─── HELL-EC-01: put / get round-trip returns identical vector ───
  test("HELL-EC-01 put/get round-trip preserves vector bytes", async () => {
    const cache = newInMemoryEmbedCache({ capacity: 100 })
    const vector = [0.1, -0.25, 0.5, 0.75, -1.0]
    cache.put("hello world", MODEL_A, vector)
    const hit = cache.get("hello world", MODEL_A)
    expect(hit).not.toBeNull()
    expect((hit as EmbedCacheHit).vector).toEqual(vector)
    // not aliased — caller-mutation MUST NOT poison cache
    const v2 = (hit as EmbedCacheHit).vector as number[]
    expect(v2).not.toBe(vector)
  })

  // ─── HELL-EC-02: get-miss returns null (NEVER undefined / throw) ───
  test("HELL-EC-02 get miss returns null", () => {
    const cache = newInMemoryEmbedCache()
    expect(cache.get("never put", MODEL_A)).toBeNull()
  })

  // ─── HELL-EC-03: same text different modelTag — cache miss ───
  test("HELL-EC-03 different modelTag is a cache miss for identical text", () => {
    const cache = newInMemoryEmbedCache()
    cache.put("same text", MODEL_A, [1, 2, 3])
    expect(cache.get("same text", MODEL_A)).not.toBeNull()
    expect(cache.get("same text", MODEL_B)).toBeNull()
  })

  // ─── HELL-EC-04: LRU eviction at cap ───
  test("HELL-EC-04 LRU evicts oldest at capacity", () => {
    const cache = newInMemoryEmbedCache({ capacity: 3 })
    cache.put("a", MODEL_A, [1])
    cache.put("b", MODEL_A, [2])
    cache.put("c", MODEL_A, [3])
    expect(cache.size()).toBe(3)
    cache.put("d", MODEL_A, [4])
    expect(cache.size()).toBe(3)
    // "a" is the oldest — evicted
    expect(cache.get("a", MODEL_A)).toBeNull()
    expect(cache.get("b", MODEL_A)).not.toBeNull()
    expect(cache.get("c", MODEL_A)).not.toBeNull()
    expect(cache.get("d", MODEL_A)).not.toBeNull()
  })

  // ─── HELL-EC-05: invalidate(modelTag) drops ONLY that tag ───
  test("HELL-EC-05 invalidate drops only entries with that modelTag", () => {
    const cache = newInMemoryEmbedCache()
    cache.put("x", MODEL_A, [1])
    cache.put("y", MODEL_A, [2])
    cache.put("z", MODEL_B, [3])
    expect(cache.size()).toBe(3)
    const removed = cache.invalidate(MODEL_A)
    expect(removed).toBe(2)
    expect(cache.size()).toBe(1)
    expect(cache.get("x", MODEL_A)).toBeNull()
    expect(cache.get("y", MODEL_A)).toBeNull()
    expect(cache.get("z", MODEL_B)).not.toBeNull()
  })

  // ─── HELL-EC-06: size() is exact (and reflects evictions) ───
  test("HELL-EC-06 size() is exact and reflects evictions", () => {
    const cache = newInMemoryEmbedCache({ capacity: 2 })
    expect(cache.size()).toBe(0)
    cache.put("a", MODEL_A, [1])
    expect(cache.size()).toBe(1)
    cache.put("b", MODEL_A, [2])
    expect(cache.size()).toBe(2)
    cache.put("c", MODEL_A, [3])
    expect(cache.size()).toBe(2) // capped
  })

  // ─── HELL-EC-07: clear() resets to 0 ───
  test("HELL-EC-07 clear() resets size and erases entries", () => {
    const cache = newInMemoryEmbedCache()
    cache.put("a", MODEL_A, [1])
    cache.put("b", MODEL_B, [2])
    cache.clear()
    expect(cache.size()).toBe(0)
    expect(cache.get("a", MODEL_A)).toBeNull()
    expect(cache.get("b", MODEL_B)).toBeNull()
  })

  // ─── HELL-EC-08: hash is deterministic for same input ───
  test("HELL-EC-08 hashText is deterministic", async () => {
    const a = await hashText("the quick brown fox")
    const b = await hashText("the quick brown fox")
    const c = await hashText("THE QUICK BROWN FOX") // diff input -> diff hash
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    // SHA-256 hex = 64 chars
    expect(a.length).toBe(64)
    expect(/^[0-9a-f]{64}$/.test(a)).toBe(true)
  })

  // ─── HELL-EC-09: sqlite db file is mode 0600 ───
  let tmpDir = ""
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "quanta-embed-cache-"))
  })
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  test("HELL-EC-09 sqlite cache file has 0600 permission bits", () => {
    const dbPath = join(tmpDir, "ec.db")
    const cache = newSqliteEmbedCache({ path: dbPath })
    cache.put("any", MODEL_A, [1, 2, 3])
    const mode = statSync(dbPath).mode & 0o777
    expect(mode).toBe(0o600)
    cache.clear()
  })

  // ─── HELL-EC-10: sqlite TTL expires entries past ttl ───
  test("HELL-EC-10 sqlite TTL expires entries past ttlMs", () => {
    const dbPath = join(tmpDir, "ttl.db")
    let now = 1_000_000
    const cache = newSqliteEmbedCache({
      path: dbPath,
      ttlMs: 100,
      now: () => now,
    })
    cache.put("hello", MODEL_A, [9, 9])
    expect(cache.get("hello", MODEL_A)).not.toBeNull()
    now += 50
    expect(cache.get("hello", MODEL_A)).not.toBeNull()
    now += 60 // total +110 > 100ms TTL
    expect(cache.get("hello", MODEL_A)).toBeNull()
  })

  // ─── HELL-EC-11: sqlite reload — entries survive process boundary ───
  test("HELL-EC-11 sqlite cache persists across reload", () => {
    const dbPath = join(tmpDir, "persist.db")
    const c1 = newSqliteEmbedCache({ path: dbPath })
    c1.put("survive", MODEL_A, [3.14, 2.71])
    // simulate process restart — re-open same file
    const c2 = newSqliteEmbedCache({ path: dbPath })
    const hit = c2.get("survive", MODEL_A)
    expect(hit).not.toBeNull()
    expect((hit as EmbedCacheHit).vector).toEqual([3.14, 2.71])
  })

  // ─── HELL-EC-12: in-memory and sqlite expose identical port surface ───
  test("HELL-EC-12 in-memory and sqlite share the same EmbedCache surface", () => {
    const dbPath = join(tmpDir, "surface.db")
    const mem: EmbedCache = newInMemoryEmbedCache()
    const sql: EmbedCache = newSqliteEmbedCache({ path: dbPath })
    for (const c of [mem, sql]) {
      expect(typeof c.get).toBe("function")
      expect(typeof c.put).toBe("function")
      expect(typeof c.invalidate).toBe("function")
      expect(typeof c.size).toBe("function")
      expect(typeof c.clear).toBe("function")
      c.put("k", MODEL_A, [1])
      expect(c.get("k", MODEL_A)).not.toBeNull()
      expect(c.invalidate(MODEL_A)).toBe(1)
      expect(c.size()).toBe(0)
    }
  })

  // ─── HELL-EC-13: 1000 put/get round-trips — sanity perf budget ───
  test("HELL-EC-13 1000 put/get is well under 1s", async () => {
    const cache = newInMemoryEmbedCache({ capacity: 2000 })
    const v = [0.1, 0.2, 0.3, 0.4]
    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      cache.put(`text-${i}`, MODEL_A, v)
    }
    for (let i = 0; i < 1000; i++) {
      const hit = cache.get(`text-${i}`, MODEL_A)
      expect(hit).not.toBeNull()
    }
    const elapsedMs = performance.now() - start
    expect(elapsedMs).toBeLessThan(1000)
  })

  // ─── HELL-EC-14: default-OFF — `none` adapter never caches ───
  test("HELL-EC-14 none adapter is byte-identical to no cache", () => {
    const cache = newNoneEmbedCache()
    cache.put("anything", MODEL_A, [1, 2, 3])
    expect(cache.get("anything", MODEL_A)).toBeNull()
    expect(cache.size()).toBe(0)
    expect(cache.invalidate(MODEL_A)).toBe(0)
    cache.clear() // no-op
    expect(cache.size()).toBe(0)
  })

  // ─── HELL-EC-15: modelTag canonical format validation ───
  test("HELL-EC-15 modelTag canonical format validation", () => {
    expect(isCanonicalModelTag("openai-text-embedding-3-small-v1-d1536")).toBe(true)
    expect(isCanonicalModelTag("voyage-voyage-3-v2-d1024")).toBe(true)
    expect(isCanonicalModelTag("cohere-embed-multilingual-v3-d384")).toBe(true)
    // missing version
    expect(isCanonicalModelTag("openai-model-d1536")).toBe(false)
    // missing dim
    expect(isCanonicalModelTag("openai-model-v1")).toBe(false)
    // wrong tail order
    expect(isCanonicalModelTag("openai-model-d1024-v1")).toBe(false)
    // empty
    expect(isCanonicalModelTag("")).toBe(false)
    // missing provider component
    expect(isCanonicalModelTag("v1-d1024")).toBe(false)
  })

  // ─── extra invariant proof — env-driven swap ───
  test("env adapter swap: QUANTA_EMBED_CACHE controls the wire", () => {
    expect(resolveEmbedCacheFromEnv({ QUANTA_EMBED_CACHE: "none" }).size()).toBe(0)
    const mem = resolveEmbedCacheFromEnv({
      QUANTA_EMBED_CACHE: "in-memory",
    })
    mem.put("k", MODEL_A, [1])
    expect(mem.get("k", MODEL_A)).not.toBeNull()
  })

  // ─── extra proof — cache key shape is hash+":"+tag ───
  test("makeCacheKey shape: hash(text)+:+modelTag", async () => {
    const hash = await hashText("body")
    const key = await makeCacheKey("body", MODEL_A)
    expect(key).toBe(`${hash}:${MODEL_A}`)
  })
})
