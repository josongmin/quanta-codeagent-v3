import { describe, expect, test } from "bun:test"
import { defaultPlanQueueStore, type FollowUp, type PlanQueueStore } from "@/agent/plan-queue"

/**
 * PlanQueueStore — SOTA++ HARDENING hellgate (companion to
 * tests/unit/plan-queue-hellgate.test.ts).
 *
 * These cases seal invariants the original 22-case suite leaves implicit or
 * weakly probed. Each test names (a) the invariant it locks and (b) the
 * concrete production mutation it would catch. Cases H-1, H-2, H-5 were
 * verified RED-on-injection against src/agent/plan-queue.ts.
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
// H-1. urgent jumps ahead of an EARLIER non-urgent in drain
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — H-1. urgent priority across distinct timestamps", () => {
  // INVARIANT (contract drain ordering): urgency is the PRIMARY drain sort
  //   key — it outranks enqueuedAtMs. A later-arriving urgent must drain
  //   BEFORE an earlier non-urgent, not after it.
  // KILLS: dropping the `urgent` comparator and sorting drain purely by
  //   enqueuedAtMs (a.e.enqueuedAtMs - b.e.enqueuedAtMs only). With an
  //   INCREMENTING clock the two entries have distinct ms, so an ms-only
  //   sort would yield [non-urgent, urgent] — wrong.
  test("HARD-1: non-urgent@t1 then urgent@t2 → drain order = [urgent, non-urgent]", () => {
    const s = fresh() // incrementing tick: first enqueue=1001, second=1002
    s.enqueue(input("t1", "non-urgent", { urgent: false })) // enqueuedAtMs 1001
    s.enqueue(input("t1", "urgent", { urgent: true })) // enqueuedAtMs 1002 (LATER)

    // Sanity: the urgent entry really did get the LATER timestamp, so this
    // test is not vacuous — an ms-only sort would put it second.
    const stamps = s.peek("t1")
    const nonUrgentMs = stamps.find((e) => e.text === "non-urgent")?.enqueuedAtMs
    const urgentMs = stamps.find((e) => e.text === "urgent")?.enqueuedAtMs
    expect(nonUrgentMs).toBe(1001)
    expect(urgentMs).toBe(1002)
    expect(urgentMs).toBeGreaterThan(nonUrgentMs as number)

    const drained = s.drain("t1", 1)
    expect(drained.map((e) => e.text)).toEqual(["urgent", "non-urgent"])
  })
})

// ─────────────────────────────────────────────────────────────
// H-2. LRU urgent-fallback drops OLDEST urgent (3 urgent over cap 2)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — H-2. all-urgent overflow evicts OLDEST urgent", () => {
  // INVARIANT (contract #6, tier-2 fallback): when every live entry is
  //   urgent and the cap is exceeded, the OLDEST urgent (smallest
  //   enqueuedAtMs) is dropped — the two retained are the NEWEST two.
  // KILLS: flipping the eviction picker to choose the NEWEST urgent
  //   (e.g. `e.enqueuedAtMs > bestAt` instead of `<`), which would retain
  //   the oldest two and evict the freshest input.
  test("HARD-2: cap 2, 3 urgent (ascending ts) → retain 2 NEWEST, evict oldest", () => {
    const s = fresh(2) // incrementing tick: u1=1001, u2=1002, u3=1003
    s.enqueue(input("t1", "u1", { urgent: true }))
    s.enqueue(input("t1", "u2", { urgent: true }))
    s.enqueue(input("t1", "u3", { urgent: true }))

    const q = s.peek("t1")
    expect(q).toHaveLength(2)
    const texts = q.map((e) => e.text)
    // The two NEWEST (u2, u3) survive; the OLDEST urgent (u1) is evicted.
    expect(texts).toContain("u2")
    expect(texts).toContain("u3")
    expect(texts).not.toContain("u1")

    // Strengthen: confirm via timestamps that the survivors are the two
    // with the LARGEST enqueuedAtMs, not merely "u1 absent".
    const survivorStamps = q.map((e) => e.enqueuedAtMs).sort((a, b) => a - b)
    expect(survivorStamps).toEqual([1002, 1003])
  })
})

// ─────────────────────────────────────────────────────────────
// H-3. stable tiebreak under a pinned clock
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — H-3. stable insertion-order tiebreak", () => {
  // INVARIANT (contract drain ordering, final comparator): when urgency
  //   AND enqueuedAtMs are equal, drain preserves INSERTION order (the
  //   `a.idx - b.idx` stable tiebreak).
  // KILLS: removing the index tiebreak (non-stable sort) or reversing it —
  //   with all four entries sharing one ms and one urgency tier, only the
  //   index keeps [a,b,c,d] deterministic.
  test("HARD-3: pinned clock, 4 non-urgent a,b,c,d → drain = [a,b,c,d]", () => {
    const fixed = (): number => 100
    const s = defaultPlanQueueStore({ now: fixed })
    s.enqueue(input("t1", "a"))
    s.enqueue(input("t1", "b"))
    s.enqueue(input("t1", "c"))
    s.enqueue(input("t1", "d"))

    // All four share the same enqueuedAtMs, so urgency+ms can't disambiguate.
    expect(s.peek("t1").every((e) => e.enqueuedAtMs === 100)).toBe(true)

    const drained = s.drain("t1", 1)
    expect(drained.map((e) => e.text)).toEqual(["a", "b", "c", "d"])
  })
})

// ─────────────────────────────────────────────────────────────
// H-4. snapshot isolation (peek + inspect return defensive copies)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — H-4. peek/inspect entries are snapshots", () => {
  // INVARIANT (peek/inspect doc): returned entries are SNAPSHOTS — mutating
  //   a returned FollowUp must not bleed into the store's internal record.
  // KILLS: returning internal `Entry` objects by reference from peek/inspect
  //   instead of cloning via toSnapshot(). If aliased, flipping urgent on the
  //   returned object would corrupt the stored entry (and its drain order).
  test("HARD-4a: mutating peek()[0].urgent does NOT change the stored entry", () => {
    const s = fresh()
    s.enqueue(input("t1", "x", { urgent: false }))

    const s0 = s.peek("t1")[0]
    expect(s0?.urgent).toBe(false)
    ;(s0 as { urgent: boolean }).urgent = true

    // Re-read: the store's own copy must still be urgent:false.
    const after = s.peek("t1")[0]
    expect(after?.urgent).toBe(false)
  })

  test("HARD-4b: mutating inspect() entry's urgent does NOT change the store", () => {
    const s = fresh()
    s.enqueue(input("t1", "x", { urgent: false }))

    const fromInspect = s.inspect().get("t1")?.[0]
    expect(fromInspect?.urgent).toBe(false)
    ;(fromInspect as { urgent: boolean }).urgent = true

    const after = s.inspect().get("t1")?.[0]
    expect(after?.urgent).toBe(false)
    // And peek agrees the store is untouched.
    expect(s.peek("t1")[0]?.urgent).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// H-5. maxPerThread clamped at the lower bound (>= 1)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — H-5. maxPerThread lower-bound clamp", () => {
  // INVARIANT (PlanQueueStoreOpts doc: "Values < 1 are clamped to 1"): a
  //   cap of 0 or a negative cap must NOT swallow the only enqueued entry.
  // KILLS: dropping the clamp (`Math.max(1, ...)` → using the raw opt). With
  //   maxPerThread:0 an un-clamped cap evicts on every insert, so peek would
  //   be length 0 — losing user input entirely.
  test("HARD-5a: maxPerThread:0 → one enqueue still peekable (clamped to >=1)", () => {
    resetTick()
    const s = defaultPlanQueueStore({ maxPerThread: 0, now: tick })
    const r = s.enqueue(input("t1", "keep-me"))
    expect(r.collapsed).toBe(false)
    const q = s.peek("t1")
    expect(q).toHaveLength(1)
    expect(q[0]?.text).toBe("keep-me")
  })

  test("HARD-5b: maxPerThread:-5 → one enqueue still peekable (clamped to >=1)", () => {
    resetTick()
    const s = defaultPlanQueueStore({ maxPerThread: -5, now: tick })
    s.enqueue(input("t1", "keep-me"))
    const q = s.peek("t1")
    expect(q).toHaveLength(1)
    expect(q[0]?.text).toBe("keep-me")
  })
})

// ─────────────────────────────────────────────────────────────
// H-6. dedup is LIVE-WINDOW only (drained entries never collapse)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — H-6. dedup window is live-only", () => {
  // INVARIANT (contract #5 DEDUP WINDOW): dedup matches ONLY entries with
  //   drainedIntoTurn === null. A re-typed text whose prior copy was drained
  //   becomes a brand-new entry (new id, not collapsed).
  // KILLS: a global/forever textHash dedup that ignores drainedIntoTurn —
  //   it would collapse the re-type into the drained tombstone, returning a
  //   stale id and an empty queue.
  test("HARD-6a: drain then re-enqueue same text → NEW id, not collapsed, peek=1", () => {
    const s = fresh()
    const oldId = s.enqueue(input("t1", "X")).id
    s.enqueue(input("t1", "Y"))
    const drained = s.drain("t1", 9)
    expect(drained.map((e) => e.text).sort()).toEqual(["X", "Y"])
    expect(s.peek("t1")).toHaveLength(0)

    const re = s.enqueue(input("t1", "X"))
    expect(re.collapsed).toBe(false)
    expect(re.id).not.toBe(oldId)
    expect(s.peek("t1")).toHaveLength(1)
    expect(s.peek("t1")[0]?.text).toBe("X")
  })

  test("HARD-6b: same text enqueued twice while LIVE → collapsed:true, single entry", () => {
    const s = fresh()
    const r1 = s.enqueue(input("t1", "X"))
    const r2 = s.enqueue(input("t1", "X"))
    expect(r1.collapsed).toBe(false)
    expect(r2.collapsed).toBe(true)
    expect(r2.id).toBe(r1.id)
    expect(s.peek("t1")).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────
// H-7. unicode-correct dedup (byte-equal collapses; distinct does not)
// ─────────────────────────────────────────────────────────────

describe("PlanQueueStore — H-7. unicode dedup correctness", () => {
  // INVARIANT (contract #5 + default sha256 hasher over the raw text): two
  //   byte-identical unicode strings collapse; two genuinely-different
  //   unicode strings do not. The hasher must operate on the full string,
  //   not an ascii-truncated / lossy view.
  // KILLS: a hasher that drops non-ascii bytes (would over-collapse distinct
  //   emoji) or one that mangles multibyte chars (would fail to collapse the
  //   identical "café").
  test("HARD-7a: identical 'café' enqueued twice → collapses to one entry", () => {
    const s = fresh()
    const r1 = s.enqueue(input("t1", "café"))
    const r2 = s.enqueue(input("t1", "café"))
    expect(r1.collapsed).toBe(false)
    expect(r2.collapsed).toBe(true)
    expect(r2.id).toBe(r1.id)
    expect(s.peek("t1")).toHaveLength(1)
  })

  test("HARD-7b: distinct emoji strings → NO collapse, two entries", () => {
    const s = fresh()
    const r1 = s.enqueue(input("t1", "🚀 launch"))
    const r2 = s.enqueue(input("t1", "🔥 burn"))
    expect(r1.collapsed).toBe(false)
    expect(r2.collapsed).toBe(false)
    expect(r1.id).not.toBe(r2.id)
    expect(s.peek("t1")).toHaveLength(2)
    expect(s.peek("t1").map((e) => e.text)).toEqual(["🚀 launch", "🔥 burn"])
  })
})
