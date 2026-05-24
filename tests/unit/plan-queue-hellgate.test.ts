import { describe, expect, test } from "bun:test"
import { defaultPlanQueueStore, type FollowUp, type PlanQueueStore } from "@/agent/plan-queue"

/**
 * PlanQueueStore — hellgate (ADR-0128).
 *
 * Pure in-memory follow-up queue for mid-turn user input replay (Codex's
 * unique `queued-follow-ups` pattern). These 22 cases seal the 6 contract
 * clauses + LRU eviction edge cases + exactOptional invariant.
 */

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}
const resetTick = (start = 1_000): void => {
  tickValue = start
}

const fresh = (maxPerThread = 32): PlanQueueStore => {
  resetTick()
  return defaultPlanQueueStore({ maxPerThread, now: tick })
}

/** Base input WITHOUT id / enqueuedAtMs / textHash / drainedIntoTurn. */
const input = (
  threadId: string,
  text: string,
  overrides: Partial<{
    source: FollowUp["source"]
    pausedReason: FollowUp["pausedReason"]
    arrivedDuringTurn: number
    urgent: boolean
    metadata: Readonly<Record<string, string>>
    label: string
  }> = {},
) => ({
  threadId,
  text,
  source: overrides.source ?? ("user_keystroke" as const),
  pausedReason: overrides.pausedReason ?? ("tool_in_flight" as const),
  arrivedDuringTurn: overrides.arrivedDuringTurn ?? 0,
  urgent: overrides.urgent ?? false,
  metadata: overrides.metadata ?? {},
  ...(overrides.label !== undefined ? { label: overrides.label } : {}),
})

// ─────────────────────────────────────────────────────────────
// A. enqueue happy (4)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — A. enqueue happy", () => {
  test("HELL-1: single enqueue returns id; peek shows 1 entry", () => {
    const s = fresh()
    const id = s.enqueue(input("t1", "hello"))
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
    const queue = s.peek("t1")
    expect(queue).toHaveLength(1)
    expect(queue[0]?.id).toBe(id)
  })

  test("HELL-2: enqueue 3 → peek shows 3 in insertion order", () => {
    const s = fresh()
    s.enqueue(input("t1", "a"))
    s.enqueue(input("t1", "b"))
    s.enqueue(input("t1", "c"))
    const texts = s.peek("t1").map((e) => e.text)
    expect(texts).toEqual(["a", "b", "c"])
  })

  test("HELL-3: id format `fu-<thread>-<n>` (incrementing per store)", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "a"))
    const id2 = s.enqueue(input("t1", "b"))
    const id3 = s.enqueue(input("t2", "c"))
    expect(id1).toMatch(/^fu-t1-\d+$/)
    expect(id2).toMatch(/^fu-t1-\d+$/)
    expect(id3).toMatch(/^fu-t2-\d+$/)
    // Counter is monotone across threads (per-store, not per-thread).
    const n1 = Number(id1.split("-").pop())
    const n2 = Number(id2.split("-").pop())
    const n3 = Number(id3.split("-").pop())
    expect(n2).toBeGreaterThan(n1)
    expect(n3).toBeGreaterThan(n2)
  })

  test("HELL-4: enqueuedAtMs uses injected clock verbatim", () => {
    resetTick(5_000)
    const s = defaultPlanQueueStore({ now: tick })
    s.enqueue(input("t1", "a"))
    s.enqueue(input("t1", "b"))
    const stamps = s.peek("t1").map((e) => e.enqueuedAtMs)
    // First tick returns 5_001 (pre-increment + return), second 5_002.
    expect(stamps).toEqual([5_001, 5_002])
  })
})

// ─────────────────────────────────────────────────────────────
// B. Dedup (3)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — B. dedup", () => {
  test("HELL-5: same text + thread enqueued twice → second collapses; peek=1", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "fix X"))
    const id2 = s.enqueue(input("t1", "fix X"))
    expect(id2).toBe(id1) // returned existing id
    expect(s.peek("t1")).toHaveLength(1)
  })

  test("HELL-6: same text + DIFFERENT thread → both kept (per-thread dedup)", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "fix X"))
    const id2 = s.enqueue(input("t2", "fix X"))
    expect(id2).not.toBe(id1)
    expect(s.peek("t1")).toHaveLength(1)
    expect(s.peek("t2")).toHaveLength(1)
  })

  test("HELL-7: same text but first already drained → second is NEW entry", () => {
    const s = fresh()
    const id1 = s.enqueue(input("t1", "fix X"))
    const drained = s.drain("t1", 5)
    expect(drained).toHaveLength(1)
    expect(drained[0]?.id).toBe(id1)
    // After drain, peek is empty; re-enqueuing the same text gets a NEW id.
    expect(s.peek("t1")).toHaveLength(0)
    const id2 = s.enqueue(input("t1", "fix X"))
    expect(id2).not.toBe(id1)
    expect(s.peek("t1")).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────
// C. urgent OR-in (2)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — C. urgent OR-in on dedup", () => {
  test("HELL-8: non-urgent then urgent → existing entry's urgent becomes true", () => {
    const s = fresh()
    s.enqueue(input("t1", "X", { urgent: false }))
    s.enqueue(input("t1", "X", { urgent: true }))
    const q = s.peek("t1")
    expect(q).toHaveLength(1)
    expect(q[0]?.urgent).toBe(true)
  })

  test("HELL-9: urgent then non-urgent → urgent stays true (OR-in)", () => {
    const s = fresh()
    s.enqueue(input("t1", "X", { urgent: true }))
    s.enqueue(input("t1", "X", { urgent: false }))
    const q = s.peek("t1")
    expect(q).toHaveLength(1)
    expect(q[0]?.urgent).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// D. drain (4)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — D. drain", () => {
  test("HELL-10: drain on empty thread returns []", () => {
    const s = fresh()
    expect(s.drain("ghost", 1)).toEqual([])
  })

  test("HELL-11: drain returns enqueued order; drainedIntoTurn = currentTurn", () => {
    const s = fresh()
    s.enqueue(input("t1", "a"))
    s.enqueue(input("t1", "b"))
    s.enqueue(input("t1", "c"))
    const drained = s.drain("t1", 7)
    expect(drained.map((e) => e.text)).toEqual(["a", "b", "c"])
    expect(drained.every((e) => e.drainedIntoTurn === 7)).toBe(true)
  })

  test("HELL-12: drain doesn't double-drain (second drain returns [])", () => {
    const s = fresh()
    s.enqueue(input("t1", "a"))
    expect(s.drain("t1", 1)).toHaveLength(1)
    expect(s.drain("t1", 2)).toEqual([])
  })

  test("HELL-13: urgent-first ordering within same enqueuedAtMs", () => {
    // Pin clock so all 4 enqueues share the same ms.
    const fixed = (): number => 100
    const s = defaultPlanQueueStore({ now: fixed })
    s.enqueue(input("t1", "n1", { urgent: false }))
    s.enqueue(input("t1", "u1", { urgent: true }))
    s.enqueue(input("t1", "n2", { urgent: false }))
    s.enqueue(input("t1", "u2", { urgent: true }))
    const drained = s.drain("t1", 1)
    // urgent first (u1 then u2), then non-urgent (n1 then n2)
    expect(drained.map((e) => e.text)).toEqual(["u1", "u2", "n1", "n2"])
  })
})

// ─────────────────────────────────────────────────────────────
// E. LRU eviction (3)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — E. LRU eviction", () => {
  test("HELL-14: maxPerThread=3, enqueue 4 non-urgent → drop 1 oldest", () => {
    const s = fresh(3)
    s.enqueue(input("t1", "a"))
    s.enqueue(input("t1", "b"))
    s.enqueue(input("t1", "c"))
    s.enqueue(input("t1", "d"))
    const texts = s.peek("t1").map((e) => e.text)
    expect(texts).toHaveLength(3)
    // 'a' (oldest non-urgent) dropped; b/c/d remain.
    expect(texts).toEqual(["b", "c", "d"])
  })

  test("HELL-15: maxPerThread=2, 1 urgent + 2 non-urgent → drop 1 non-urgent", () => {
    const s = fresh(2)
    s.enqueue(input("t1", "u", { urgent: true })) // urgent, oldest
    s.enqueue(input("t1", "n1", { urgent: false }))
    s.enqueue(input("t1", "n2", { urgent: false }))
    // Overflow: oldest non-urgent is n1 → dropped. u (urgent) preserved.
    const texts = s.peek("t1").map((e) => e.text)
    expect(texts).toHaveLength(2)
    expect(texts).toContain("u")
    expect(texts).toContain("n2")
    expect(texts).not.toContain("n1")
  })

  test("HELL-16: maxPerThread=1, 2 urgent → second pushes first out (all-urgent fallback)", () => {
    // All-urgent overflow: cap is a HARD ceiling, caller cannot prevent
    // it, so we drop OLDEST urgent. Documented trade-off in contract #6.
    const s = fresh(1)
    s.enqueue(input("t1", "u1", { urgent: true }))
    s.enqueue(input("t1", "u2", { urgent: true }))
    const texts = s.peek("t1").map((e) => e.text)
    expect(texts).toEqual(["u2"])
  })
})

// ─────────────────────────────────────────────────────────────
// F. clear & inspect (3)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — F. clear & inspect", () => {
  test("HELL-17: clear(thread) returns evicted count; peek then []", () => {
    const s = fresh()
    s.enqueue(input("t1", "a"))
    s.enqueue(input("t1", "b"))
    expect(s.clear("t1")).toBe(2)
    expect(s.peek("t1")).toEqual([])
    // clear on empty/unknown is 0.
    expect(s.clear("ghost")).toBe(0)
  })

  test("HELL-18: inspect returns Map with all threads' current contents", () => {
    const s = fresh()
    s.enqueue(input("t1", "a"))
    s.enqueue(input("t1", "b"))
    s.enqueue(input("t2", "c"))
    const map = s.inspect()
    expect(map.size).toBe(2)
    expect(map.get("t1")?.map((e) => e.text)).toEqual(["a", "b"])
    expect(map.get("t2")?.map((e) => e.text)).toEqual(["c"])
  })

  test("HELL-19: inspect's returned Map is a SNAPSHOT (mutation does not affect store)", () => {
    const s = fresh()
    s.enqueue(input("t1", "a"))
    const map = s.inspect() as Map<string, FollowUp[]>
    // Try to mutate — even if TS would refuse, runtime mutation must not leak.
    try {
      map.clear()
    } catch {
      // Frozen Maps would throw — also acceptable.
    }
    // Store still has t1.
    expect(s.peek("t1")).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────
// G. hash injection (2)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — G. hash injection", () => {
  test("HELL-20: custom hasher used for textHash", () => {
    const custom = (text: string): string => `H:${text.length}`
    const s = defaultPlanQueueStore({ hash: custom, now: tick })
    s.enqueue(input("t1", "hello"))
    const q = s.peek("t1")
    expect(q[0]?.textHash).toBe("H:5")
  })

  test("HELL-21: default hasher produces 16-hex prefix (sanity)", () => {
    const s = defaultPlanQueueStore() // no hash override
    s.enqueue(input("t1", "anything"))
    const q = s.peek("t1")
    expect(q[0]?.textHash).toMatch(/^[0-9a-f]{16}$/)
  })
})

// ─────────────────────────────────────────────────────────────
// H. exactOptional / metadata (1)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — H. exactOptional", () => {
  test("HELL-22: enqueue without `label` → entry has NO `label` key (not undefined)", () => {
    const s = fresh()
    s.enqueue(input("t1", "no-label-here"))
    const q = s.peek("t1")
    expect(q).toHaveLength(1)
    const entry = q[0]
    expect(entry).toBeDefined()
    if (entry === undefined) return
    // Must NOT have a `label` key at all — exactOptionalPropertyTypes.
    expect("label" in entry).toBe(false)
    // With label, the key IS present.
    s.enqueue(input("t1", "with-label", { label: "chip" }))
    const q2 = s.peek("t1")
    const labeled = q2.find((e) => e.text === "with-label")
    expect(labeled).toBeDefined()
    expect(labeled?.label).toBe("chip")
    expect("label" in (labeled as object)).toBe(true)
  })
})
