import { describe, expect, test } from "bun:test"
import {
  ConversationCheckpointError,
  type ConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import { lruConversationCheckpointStore } from "@/agent/conversation-checkpoint-lru"
import type { Message } from "@/llm"

/**
 * ConversationCheckpointStore — lru-cache-backed hellgate (ADR-0184).
 *
 * Mirror of `tests/unit/conversation-checkpoint-hellgate.test.ts`. Same 23
 * cases (renumbered LRU-* to disambiguate in test output) targeting the
 * `lruConversationCheckpointStore` factory. The two impls must observe
 * IDENTICAL externally visible behaviour — this file is the parity gate.
 */

const msg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}

const fresh = (maxEntries = 50): ConversationCheckpointStore => {
  tickValue = 1_000
  return lruConversationCheckpointStore({ maxEntries, now: tick })
}

describe("lruConversationCheckpointStore — happy path", () => {
  test("LRU-1: record + list returns the snapshot", () => {
    const s = fresh()
    s.record("t1", [msg("hello")])
    const all = s.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe("t1")
    expect(all[0]?.messages).toHaveLength(1)
  })

  test("LRU-2: list returns NEWEST first", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t3", [msg("c")])
    const ids = s.list().map((x) => x.id)
    expect(ids).toEqual(["t3", "t2", "t1"])
  })

  test("LRU-3: restore returns the SAME frozen array", () => {
    const s = fresh()
    s.record("t1", [msg("hello"), msg("world")])
    const restored = s.restore("t1")
    expect(restored).not.toBeNull()
    expect(restored).toHaveLength(2)
  })

  test("LRU-4: restore for unknown id returns null (no throw)", () => {
    const s = fresh()
    expect(s.restore("nope")).toBeNull()
  })
})

describe("lruConversationCheckpointStore — replacement semantics", () => {
  test("LRU-5: re-record same id REPLACES (not duplicates)", () => {
    const s = fresh()
    s.record("t1", [msg("first")])
    s.record("t1", [msg("second")])
    const all = s.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.messages[0]?.content).toEqual([{ type: "text", text: "second" }])
  })

  test("LRU-6: re-record same id MOVES it to newest position (LRU touch)", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t1", [msg("a-v2")]) // touch t1
    const ids = s.list().map((x) => x.id)
    expect(ids).toEqual(["t1", "t2"]) // t1 now newest
  })

  test("LRU-7: re-record updates takenAt", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    const firstTs = s.list()[0]?.takenAt ?? 0
    s.record("t1", [msg("a-v2")])
    const secondTs = s.list()[0]?.takenAt ?? 0
    expect(secondTs).toBeGreaterThan(firstTs)
  })
})

describe("lruConversationCheckpointStore — immutability", () => {
  test("LRU-8: caller mutating their source array does NOT affect stored snapshot", () => {
    const s = fresh()
    const source: Message[] = [msg("a"), msg("b")]
    s.record("t1", source)
    source.push(msg("c")) // post-record mutation
    source[0] = msg("hijacked") // post-record replacement
    const restored = s.restore("t1")
    expect(restored).toHaveLength(2) // not 3
    expect(restored?.[0]?.content).toEqual([{ type: "text", text: "a" }]) // not "hijacked"
  })

  test("LRU-9: stored snapshot array is frozen at the array level", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    const restored = s.restore("t1")
    expect(Object.isFrozen(restored)).toBe(true)
    expect(() => {
      ;(restored as Message[]).push(msg("nope"))
    }).toThrow()
  })

  test("LRU-10: list() result does not share identity with internal store across calls", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    const first = s.list()
    const second = s.list()
    expect(first).not.toBe(second) // fresh array each time
    expect(first).toEqual(second) // but equivalent
  })
})

describe("lruConversationCheckpointStore — LRU eviction", () => {
  test("LRU-11: at cap → next record evicts oldest", () => {
    const s = fresh(3)
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t3", [msg("c")])
    s.record("t4", [msg("d")]) // evicts t1
    const ids = s.list().map((x) => x.id)
    expect(ids).toEqual(["t4", "t3", "t2"])
  })

  test("LRU-12: maxEntries=1 → only newest survives", () => {
    const s = fresh(1)
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t3", [msg("c")])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0]?.id).toBe("t3")
  })

  test("LRU-13: maxEntries=0 is treated as 1 (clamped to minimum)", () => {
    const s = lruConversationCheckpointStore({ maxEntries: 0, now: tick })
    s.record("t1", [msg("a")])
    expect(s.list()).toHaveLength(1)
  })
})

describe("lruConversationCheckpointStore — prune & clear", () => {
  test("LRU-14: prune(keep=N) drops oldest until N remain; returns evicted count", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t3", [msg("c")])
    s.record("t4", [msg("d")])
    const evicted = s.prune(2)
    expect(evicted).toBe(2)
    expect(s.list().map((x) => x.id)).toEqual(["t4", "t3"])
  })

  test("LRU-15: prune(keep) >= current size → no-op, returns 0", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    expect(s.prune(50)).toBe(0)
    expect(s.list()).toHaveLength(1)
  })

  test("LRU-16: prune(keep=0) clears everything", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    expect(s.prune(0)).toBe(2)
    expect(s.list()).toHaveLength(0)
  })

  test("LRU-17: prune(negative) clamps to 0", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    expect(s.prune(-5)).toBe(1)
    expect(s.list()).toHaveLength(0)
  })

  test("LRU-18: clear() removes everything", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.clear()
    expect(s.list()).toHaveLength(0)
    expect(s.restore("t1")).toBeNull()
  })
})

describe("lruConversationCheckpointStore — input contract", () => {
  test("LRU-19: empty messages array is valid (snapshot of empty list)", () => {
    const s = fresh()
    s.record("t1", [])
    expect(s.restore("t1")).toEqual([])
  })

  test("LRU-20: non-array messages throws ConversationCheckpointError (programmer bug)", () => {
    const s = fresh()
    expect(() => {
      s.record("t1", "not-an-array" as unknown as Message[])
    }).toThrow(ConversationCheckpointError)
  })

  test("LRU-21: empty string id is permitted (discouraged but not rejected)", () => {
    const s = fresh()
    s.record("", [msg("a")])
    expect(s.restore("")).not.toBeNull()
  })
})

describe("lruConversationCheckpointStore — clock injection (determinism)", () => {
  test("LRU-22: takenAt uses injected clock verbatim", () => {
    let n = 5_000
    const s = lruConversationCheckpointStore({ now: () => n })
    s.record("t1", [msg("a")])
    expect(s.list()[0]?.takenAt).toBe(5_000)
    n = 9_999
    s.record("t2", [msg("b")])
    expect(s.list()[0]?.takenAt).toBe(9_999)
  })

  test("LRU-23: default clock is Date.now (just runtime sanity)", () => {
    const s = lruConversationCheckpointStore()
    const before = Date.now()
    s.record("t1", [msg("a")])
    const ts = s.list()[0]?.takenAt ?? 0
    const after = Date.now()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after + 5) // small slack
  })
})
