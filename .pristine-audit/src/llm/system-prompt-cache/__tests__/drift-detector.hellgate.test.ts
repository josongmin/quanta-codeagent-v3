/**
 * ★ HELLGATE — ADR-0326 strict drift detector wrapper.
 *
 * ADR-0322 audited the static prompt sources and proved they carry no
 * clock / random / per-turn input, so the cached prefix is byte-stable
 * BY CONSTRUCTION. This detector turns that PASSIVE audit into an
 * ACTIVE invariant: any caller wrapping their cache with it pays the
 * extra build cost in exchange for fail-fast detection of "a future
 * regression folded per-turn data into the cached prompt without the
 * audit catching it".
 *
 * Cases:
 *   - strict mode hit + factory same text ⇒ no throw, hit returned
 *   - strict mode hit + factory different text ⇒ DriftDetectedError
 *   - strict mode miss ⇒ normal flow, factory runs exactly ONCE (no double-build)
 *   - non-strict baseline: factory runs once on miss, never on hit
 *   - drift error message contains prev/current hash prefix
 */

import { describe, expect, test } from "bun:test"
import {
  asCacheKey,
  createInMemorySystemPromptCache,
  DriftDetectedError,
  makeStrictDriftCache,
  sha256Hex,
} from ".."

describe("ADR-0326 strict drift detector hellgate", () => {
  test("HELL-DRIFT-01 — hit + factory same text ⇒ no throw, cached entry returned", () => {
    const cache = makeStrictDriftCache(createInMemorySystemPromptCache({ now: () => 100 }))
    const key = asCacheKey("session-A")
    const first = cache.getOrBuild(key, () => "stable body")
    // Second call re-runs factory; same text ⇒ hash matches ⇒ no throw.
    const second = cache.getOrBuild(key, () => "stable body")
    expect(second.text).toBe("stable body")
    // builtAt is preserved from the first build (drift detector does NOT
    // refresh the timestamp on a matching hit).
    expect(second.builtAt).toBe(first.builtAt)
    expect(second.contentHash).toBe(sha256Hex("stable body"))
  })

  test("HELL-DRIFT-02 — hit + factory different text ⇒ throws DriftDetectedError", () => {
    const cache = makeStrictDriftCache(createInMemorySystemPromptCache())
    const key = asCacheKey("session-B")
    cache.getOrBuild(key, () => "v1 body")
    // Second call — factory returns DIFFERENT text. Strict mode detects.
    expect(() => cache.getOrBuild(key, () => "v2 body")).toThrow(DriftDetectedError)
  })

  test("HELL-DRIFT-03 — miss ⇒ normal flow, factory runs exactly ONCE (no double-build)", () => {
    const cache = makeStrictDriftCache(createInMemorySystemPromptCache())
    const key = asCacheKey("session-C")
    let calls = 0
    const result = cache.getOrBuild(key, () => {
      calls += 1
      return "miss text"
    })
    // CRITICAL: on miss the detector does NOT re-run the factory to verify.
    // That would be wasteful and impossible to distinguish from a producer
    // with a non-deterministic factory.
    expect(calls).toBe(1)
    expect(result.text).toBe("miss text")
    expect(cache.stats().misses).toBe(1)
    expect(cache.stats().hits).toBe(0)
  })

  test("HELL-DRIFT-04 — non-strict baseline: factory runs once on miss, never on hit", () => {
    // Sanity: the non-wrapped cache behaves like Codex — hit ⇒ no factory.
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-D")
    let calls = 0
    cache.getOrBuild(key, () => {
      calls += 1
      return "once"
    })
    cache.getOrBuild(key, () => {
      calls += 1
      return "MUST_NOT_RUN"
    })
    cache.getOrBuild(key, () => {
      calls += 1
      return "MUST_NOT_RUN"
    })
    expect(calls).toBe(1)
    expect(cache.stats().hits).toBe(2)
  })

  test("HELL-DRIFT-05 — drift error message contains key + prev/current hash prefix", () => {
    const cache = makeStrictDriftCache(createInMemorySystemPromptCache())
    const key = asCacheKey("session-E")
    cache.getOrBuild(key, () => "alpha")
    const prevHash = sha256Hex("alpha")
    const currentHash = sha256Hex("beta")
    try {
      cache.getOrBuild(key, () => "beta")
      throw new Error("expected DriftDetectedError to be thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(DriftDetectedError)
      const e = err as DriftDetectedError
      expect(e.key).toBe(key)
      expect(e.prevHash).toBe(prevHash)
      expect(e.currentHash).toBe(currentHash)
      // Message embeds both hash prefixes (first 12 chars) for grep-ability
      // in CI logs without dumping 64-char digests.
      expect(e.message).toContain(prevHash.slice(0, 12))
      expect(e.message).toContain(currentHash.slice(0, 12))
      expect(e.message).toContain("session-E")
    }
  })

  test("HELL-DRIFT-06 — invalidate + clearAll + stats pass through unchanged", () => {
    const inner = createInMemorySystemPromptCache()
    const cache = makeStrictDriftCache(inner)
    const key = asCacheKey("session-F")
    cache.getOrBuild(key, () => "x")
    cache.invalidate(key, "manual_reset")
    expect(cache.peek(key)).toBeNull()
    expect(cache.stats().invalidations).toBe(1)
    cache.getOrBuild(asCacheKey("A"), () => "a")
    cache.getOrBuild(asCacheKey("B"), () => "b")
    cache.clearAll("session_end")
    expect(cache.stats().size).toBe(0)
    // Counters propagate from the inner cache.
    expect(cache.stats().invalidations).toBe(3)
  })
})
