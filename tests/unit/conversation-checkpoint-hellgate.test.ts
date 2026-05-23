import { describe, expect, test } from "bun:test"
import {
  ConversationCheckpointError,
  type ConversationCheckpointStore,
  defaultConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import type { Message } from "@/llm"

/**
 * ConversationCheckpointStore — hellgate (ADR-0124).
 *
 * Pure in-memory snapshot/restore primitive (counterpart to ShadowOdb for
 * conversation history). These cases seal the 5 contract clauses + LRU
 * eviction edge cases + immutability invariant.
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
  return defaultConversationCheckpointStore({ maxEntries, now: tick })
}

describe("ConversationCheckpointStore — happy path", () => {
  test("HELL-1: record + list returns the snapshot", () => {
    const s = fresh()
    s.record("t1", [msg("hello")])
    const all = s.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe("t1")
    expect(all[0]?.messages).toHaveLength(1)
  })

  test("HELL-2: list returns NEWEST first", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t3", [msg("c")])
    const ids = s.list().map((x) => x.id)
    expect(ids).toEqual(["t3", "t2", "t1"])
  })

  test("HELL-3: restore returns the SAME frozen array", () => {
    const s = fresh()
    s.record("t1", [msg("hello"), msg("world")])
    const restored = s.restore("t1")
    expect(restored).not.toBeNull()
    expect(restored).toHaveLength(2)
  })

  test("HELL-4: restore for unknown id returns null (no throw)", () => {
    const s = fresh()
    expect(s.restore("nope")).toBeNull()
  })
})

describe("ConversationCheckpointStore — replacement semantics", () => {
  test("HELL-5: re-record same id REPLACES (not duplicates)", () => {
    const s = fresh()
    s.record("t1", [msg("first")])
    s.record("t1", [msg("second")])
    const all = s.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.messages[0]?.content).toEqual([{ type: "text", text: "second" }])
  })

  test("HELL-6: re-record same id MOVES it to newest position (LRU touch)", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t1", [msg("a-v2")]) // touch t1
    const ids = s.list().map((x) => x.id)
    expect(ids).toEqual(["t1", "t2"]) // t1 now newest
  })

  test("HELL-7: re-record updates takenAt", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    const firstTs = s.list()[0]?.takenAt ?? 0
    s.record("t1", [msg("a-v2")])
    const secondTs = s.list()[0]?.takenAt ?? 0
    expect(secondTs).toBeGreaterThan(firstTs)
  })
})

describe("ConversationCheckpointStore — immutability", () => {
  test("HELL-8: caller mutating their source array does NOT affect stored snapshot", () => {
    const s = fresh()
    const source: Message[] = [msg("a"), msg("b")]
    s.record("t1", source)
    source.push(msg("c")) // post-record mutation
    source[0] = msg("hijacked") // post-record replacement
    const restored = s.restore("t1")
    expect(restored).toHaveLength(2) // not 3
    expect(restored?.[0]?.content).toEqual([{ type: "text", text: "a" }]) // not "hijacked"
  })

  test("HELL-9: stored snapshot array is frozen at the array level", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    const restored = s.restore("t1")
    expect(Object.isFrozen(restored)).toBe(true)
    // attempting to mutate the frozen array throws in strict mode (bun test runs strict)
    expect(() => {
      ;(restored as Message[]).push(msg("nope"))
    }).toThrow()
  })

  test("HELL-10: list() result does not share identity with internal store across calls", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    const first = s.list()
    const second = s.list()
    expect(first).not.toBe(second) // fresh array each time
    expect(first).toEqual(second) // but equivalent
  })
})

describe("ConversationCheckpointStore — LRU eviction", () => {
  test("HELL-11: at cap → next record evicts oldest", () => {
    const s = fresh(3)
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t3", [msg("c")])
    s.record("t4", [msg("d")]) // evicts t1
    const ids = s.list().map((x) => x.id)
    expect(ids).toEqual(["t4", "t3", "t2"])
  })

  test("HELL-12: maxEntries=1 → only newest survives", () => {
    const s = fresh(1)
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t3", [msg("c")])
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0]?.id).toBe("t3")
  })

  test("HELL-13: maxEntries=0 is treated as 1 (clamped to minimum)", () => {
    const s = defaultConversationCheckpointStore({ maxEntries: 0, now: tick })
    s.record("t1", [msg("a")])
    expect(s.list()).toHaveLength(1)
  })
})

describe("ConversationCheckpointStore — prune & clear", () => {
  test("HELL-14: prune(keep=N) drops oldest until N remain; returns evicted count", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.record("t3", [msg("c")])
    s.record("t4", [msg("d")])
    const evicted = s.prune(2)
    expect(evicted).toBe(2)
    expect(s.list().map((x) => x.id)).toEqual(["t4", "t3"])
  })

  test("HELL-15: prune(keep) >= current size → no-op, returns 0", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    expect(s.prune(50)).toBe(0)
    expect(s.list()).toHaveLength(1)
  })

  test("HELL-16: prune(keep=0) clears everything", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    expect(s.prune(0)).toBe(2)
    expect(s.list()).toHaveLength(0)
  })

  test("HELL-17: prune(negative) clamps to 0", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    expect(s.prune(-5)).toBe(1)
    expect(s.list()).toHaveLength(0)
  })

  test("HELL-18: clear() removes everything", () => {
    const s = fresh()
    s.record("t1", [msg("a")])
    s.record("t2", [msg("b")])
    s.clear()
    expect(s.list()).toHaveLength(0)
    expect(s.restore("t1")).toBeNull()
  })
})

describe("ConversationCheckpointStore — input contract", () => {
  test("HELL-19: empty messages array is valid (snapshot of empty list)", () => {
    const s = fresh()
    s.record("t1", [])
    expect(s.restore("t1")).toEqual([])
  })

  test("HELL-20: non-array messages throws ConversationCheckpointError (programmer bug)", () => {
    const s = fresh()
    expect(() => {
      s.record("t1", "not-an-array" as unknown as Message[])
    }).toThrow(ConversationCheckpointError)
  })

  test("HELL-21: empty string id is permitted (discouraged but not rejected)", () => {
    const s = fresh()
    s.record("", [msg("a")])
    expect(s.restore("")).not.toBeNull()
  })
})

describe("ConversationCheckpointStore — clock injection (determinism)", () => {
  test("HELL-22: takenAt uses injected clock verbatim", () => {
    let n = 5_000
    const s = defaultConversationCheckpointStore({ now: () => n })
    s.record("t1", [msg("a")])
    expect(s.list()[0]?.takenAt).toBe(5_000)
    n = 9_999
    s.record("t2", [msg("b")])
    expect(s.list()[0]?.takenAt).toBe(9_999)
  })

  test("HELL-23: default clock is Date.now (just runtime sanity)", () => {
    const s = defaultConversationCheckpointStore()
    const before = Date.now()
    s.record("t1", [msg("a")])
    const ts = s.list()[0]?.takenAt ?? 0
    const after = Date.now()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after + 5) // small slack
  })
})
