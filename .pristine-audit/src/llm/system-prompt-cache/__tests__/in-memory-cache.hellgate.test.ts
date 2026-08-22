/**
 * ★ HELLGATE — ADR-0326 in-memory system prompt cache.
 *
 * Codex turn.rs:923 reads `let base_instructions = sess.get_base_instructions().await`
 * on every sampling request. The session-level value is populated once
 * at session start and never mutated mid-session — so each call after
 * the first is a cache hit, factory NOT re-invoked.
 *
 * This battery proves the in-memory adapter mirrors that contract:
 *   - empty cache miss ⇒ factory called once
 *   - same-key second call ⇒ factory NOT called
 *   - different keys ⇒ factory called per key
 *   - factory throw ⇒ no entry stored, no counter moved, throw propagates
 *   - invalidate ⇒ factory re-invoked on next call
 *   - clearAll ⇒ all entries gone + counter mirrors drop count
 *   - stats: hits / misses / invalidations all counted precisely
 *   - peek hit ⇒ no factory call, no counter change
 *   - peek miss ⇒ null
 *   - contentHash deterministic (same text ⇒ same hash)
 *   - large prompt (50 KB) hash stable
 *   - clock seam: builtAt reflects injected `now`
 */

import { describe, expect, test } from "bun:test"
import { asCacheKey, createInMemorySystemPromptCache, sha256Hex } from ".."

describe("ADR-0326 in-memory system prompt cache hellgate", () => {
  test("HELL-SPC-01 — empty cache miss ⇒ factory called once, returned", () => {
    const cache = createInMemorySystemPromptCache({ now: () => 1_000 })
    const key = asCacheKey("session-A")
    let calls = 0
    const result = cache.getOrBuild(key, () => {
      calls += 1
      return "the static prompt"
    })
    expect(calls).toBe(1)
    expect(result.text).toBe("the static prompt")
    expect(result.key).toBe(key)
    expect(result.builtAt).toBe(1_000)
    expect(result.contentHash).toBe(sha256Hex("the static prompt"))
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, invalidations: 0, size: 1 })
  })

  test("HELL-SPC-02 — same key second call ⇒ factory NOT called (hit)", () => {
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-B")
    let calls = 0
    const first = cache.getOrBuild(key, () => {
      calls += 1
      return "static body"
    })
    const second = cache.getOrBuild(key, () => {
      calls += 1
      return "MUST_NOT_RUN" // factory must not be invoked on hit
    })
    expect(calls).toBe(1)
    expect(second).toBe(first) // identity equality — same cached entry
    expect(second.text).toBe("static body")
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, invalidations: 0, size: 1 })
  })

  test("HELL-SPC-03 — different keys ⇒ factory called per key", () => {
    const cache = createInMemorySystemPromptCache()
    const keyA = asCacheKey("session-A")
    const keyB = asCacheKey("session-B")
    const calls: string[] = []
    cache.getOrBuild(keyA, () => {
      calls.push("A")
      return "A-prompt"
    })
    cache.getOrBuild(keyB, () => {
      calls.push("B")
      return "B-prompt"
    })
    cache.getOrBuild(keyA, () => {
      calls.push("A2")
      return "MUST_NOT_RUN"
    })
    expect(calls).toEqual(["A", "B"])
    expect(cache.stats()).toEqual({ hits: 1, misses: 2, invalidations: 0, size: 2 })
  })

  test("HELL-SPC-04 — factory throw ⇒ no entry stored, no counter moved, throw propagates", () => {
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-C")
    const sentinel = new Error("factory blew up")
    expect(() =>
      cache.getOrBuild(key, () => {
        throw sentinel
      }),
    ).toThrow(sentinel)
    // Critical invariant: cache is byte-identical to the pre-call state.
    expect(cache.peek(key)).toBeNull()
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, invalidations: 0, size: 0 })
    // A retry that doesn't throw should miss (proving no half-write).
    const retry = cache.getOrBuild(key, () => "second attempt")
    expect(retry.text).toBe("second attempt")
    expect(cache.stats()).toEqual({ hits: 0, misses: 1, invalidations: 0, size: 1 })
  })

  test("HELL-SPC-05 — invalidate ⇒ next call factory re-invoked", () => {
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-D")
    let calls = 0
    cache.getOrBuild(key, () => {
      calls += 1
      return "v1"
    })
    cache.invalidate(key, "config_change")
    expect(cache.peek(key)).toBeNull()
    expect(cache.stats().invalidations).toBe(1)
    cache.getOrBuild(key, () => {
      calls += 1
      return "v2"
    })
    expect(calls).toBe(2)
    expect(cache.peek(key)?.text).toBe("v2")
    expect(cache.stats()).toEqual({ hits: 0, misses: 2, invalidations: 1, size: 1 })
  })

  test("HELL-SPC-06 — invalidate unknown key ⇒ no-op (counter unchanged)", () => {
    const cache = createInMemorySystemPromptCache()
    cache.invalidate(asCacheKey("nope"), "manual_reset")
    cache.invalidate(asCacheKey("nope2"), "session_end")
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, invalidations: 0, size: 0 })
  })

  test("HELL-SPC-07 — clearAll ⇒ all entries gone, counter mirrors drop count", () => {
    const cache = createInMemorySystemPromptCache()
    cache.getOrBuild(asCacheKey("A"), () => "a")
    cache.getOrBuild(asCacheKey("B"), () => "b")
    cache.getOrBuild(asCacheKey("C"), () => "c")
    expect(cache.stats().size).toBe(3)
    cache.clearAll("session_end")
    expect(cache.stats()).toEqual({ hits: 0, misses: 3, invalidations: 3, size: 0 })
    expect(cache.peek(asCacheKey("A"))).toBeNull()
    expect(cache.peek(asCacheKey("B"))).toBeNull()
    expect(cache.peek(asCacheKey("C"))).toBeNull()
    // clearAll on empty cache is a no-op.
    cache.clearAll("manual_reset")
    expect(cache.stats().invalidations).toBe(3)
  })

  test("HELL-SPC-08 — stats: hits / misses / invalidations all counted precisely", () => {
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-E")
    cache.getOrBuild(key, () => "x") // miss
    cache.getOrBuild(key, () => "x") // hit
    cache.getOrBuild(key, () => "x") // hit
    cache.invalidate(key, "manual_reset") // invalidation
    cache.getOrBuild(key, () => "x") // miss (post-invalidation)
    cache.getOrBuild(key, () => "x") // hit
    expect(cache.stats()).toEqual({ hits: 3, misses: 2, invalidations: 1, size: 1 })
  })

  test("HELL-SPC-09 — peek hit ⇒ no factory call, no counter change", () => {
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-F")
    cache.getOrBuild(key, () => "warm")
    const statsBefore = cache.stats()
    const peeked = cache.peek(key)
    const statsAfter = cache.stats()
    expect(peeked?.text).toBe("warm")
    expect(statsBefore).toEqual(statsAfter)
  })

  test("HELL-SPC-10 — peek miss ⇒ null", () => {
    const cache = createInMemorySystemPromptCache()
    expect(cache.peek(asCacheKey("never-warmed"))).toBeNull()
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, invalidations: 0, size: 0 })
  })

  test("HELL-SPC-11 — contentHash deterministic (same text ⇒ same hash)", () => {
    const cache1 = createInMemorySystemPromptCache()
    const cache2 = createInMemorySystemPromptCache()
    const text = "the canonical system prompt body\nwith newlines\nand unicode: ✨"
    const a = cache1.getOrBuild(asCacheKey("A"), () => text)
    const b = cache2.getOrBuild(asCacheKey("B"), () => text)
    expect(a.contentHash).toBe(b.contentHash)
    expect(a.contentHash).toBe(sha256Hex(text))
    // 64 lowercase hex chars.
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("HELL-SPC-12 — large prompt (50 KB) hash stable", () => {
    const big = "x".repeat(50_000)
    const cache = createInMemorySystemPromptCache()
    const entry = cache.getOrBuild(asCacheKey("big"), () => big)
    expect(entry.text.length).toBe(50_000)
    expect(entry.contentHash).toBe(sha256Hex(big))
    // Re-fetch ⇒ identical hash, factory NOT called.
    let calls = 0
    const entry2 = cache.getOrBuild(asCacheKey("big"), () => {
      calls += 1
      return "DIFFERENT"
    })
    expect(calls).toBe(0)
    expect(entry2.contentHash).toBe(entry.contentHash)
  })

  test("HELL-SPC-13 — clock seam: builtAt reflects injected `now`", () => {
    let virtual = 5_000
    const cache = createInMemorySystemPromptCache({ now: () => virtual })
    const entry1 = cache.getOrBuild(asCacheKey("A"), () => "first")
    virtual = 9_999
    const entry2 = cache.getOrBuild(asCacheKey("B"), () => "second")
    expect(entry1.builtAt).toBe(5_000)
    expect(entry2.builtAt).toBe(9_999)
  })

  test("HELL-SPC-14 — onInvalidate hook fires per drop with correct reason", () => {
    const events: { key: string; reason: string }[] = []
    const cache = createInMemorySystemPromptCache({
      onInvalidate: (key, reason) => events.push({ key, reason }),
    })
    cache.getOrBuild(asCacheKey("A"), () => "a")
    cache.getOrBuild(asCacheKey("B"), () => "b")
    cache.invalidate(asCacheKey("A"), "config_change")
    cache.invalidate(asCacheKey("nope"), "manual_reset") // no-op — no event
    cache.clearAll("session_end")
    expect(events).toEqual([
      { key: "A", reason: "config_change" },
      { key: "B", reason: "session_end" },
    ])
  })
})
