import { describe, expect, test } from "bun:test"
import { defaultResponsesContinuationStore } from "@/llm"

describe("ResponsesContinuationStore", () => {
  test("route-level resume disable persists across clear(route) and resets on clearAll()", () => {
    const store = defaultResponsesContinuationStore()

    expect(store.canResume("lane-1")).toBe(true)
    store.markResumeUnsupported("lane-1")
    expect(store.canResume("lane-1")).toBe(false)

    store.clear("lane-1")
    expect(store.canResume("lane-1")).toBe(false)

    store.clearAll()
    expect(store.canResume("lane-1")).toBe(true)
  })

  test("HELLGATE: markResumeUnsupported on routes never put() into the store stays bounded by maxEntries", () => {
    const maxEntries = 4
    const store = defaultResponsesContinuationStore({ maxEntries })

    // Mark FAR MORE distinct routes unsupported than maxEntries, and NEVER
    // put() any of them into the store. The round-1 fix only trimmed markers
    // via store eviction (evictIfOver) — so on the still-holed code this Set
    // would grow without bound (size === total marked routes).
    const total = maxEntries * 8
    for (let i = 0; i < total; i++) {
      store.markResumeUnsupported(`never-stored-route-${i}`)
    }

    // The Set must never outgrow the same cap as the entry store. We assert the
    // bound by probing canResume across all marked routes: at most `maxEntries`
    // of them may still be retained as unsupported markers (the LRU tail).
    let stillUnsupported = 0
    for (let i = 0; i < total; i++) {
      if (!store.canResume(`never-stored-route-${i}`)) stillUnsupported++
    }
    expect(stillUnsupported).toBeLessThanOrEqual(maxEntries)

    // LRU recency contract: the most-recently marked routes survive the trim.
    expect(store.canResume(`never-stored-route-${total - 1}`)).toBe(false)
    // The oldest marker must have been evicted (head of insertion order).
    expect(store.canResume("never-stored-route-0")).toBe(true)
  })
})
