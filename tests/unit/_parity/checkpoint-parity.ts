/**
 * Shared ConversationCheckpointStore parity battery (ADR-0124 / ADR-0184).
 * Case definitions live here; hellgate files only wire factories + test id prefix.
 */

import { describe, expect, test } from "bun:test"
import {
  ConversationCheckpointError,
  type ConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import type { Message } from "@/llm"

export const checkpointMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

export interface CheckpointParityHarness {
  readonly describeLabel: string
  readonly idPrefix: string
  fresh(maxEntries?: number): ConversationCheckpointStore
  storeAtZeroCap(): ConversationCheckpointStore
  storeWithClock(now: () => number): ConversationCheckpointStore
  storeWithDefaultClock(): ConversationCheckpointStore
}

let tickValue = 1_000
const _tick = (): number => {
  tickValue += 1
  return tickValue
}

export const registerCheckpointParitySuite = (h: CheckpointParityHarness): void => {
  const id = (n: number, label: string) => `${h.idPrefix}${n}: ${label}`
  const fresh = (maxEntries = 50) => {
    tickValue = 1_000
    return h.fresh(maxEntries)
  }

  describe(`${h.describeLabel} — happy path`, () => {
    test(id(1, "record + list returns the snapshot"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("hello")])
      const all = s.list()
      expect(all).toHaveLength(1)
      expect(all[0]?.id).toBe("t1")
      expect(all[0]?.messages).toHaveLength(1)
    })

    test(id(2, "list returns NEWEST first"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      s.record("t2", [checkpointMsg("b")])
      s.record("t3", [checkpointMsg("c")])
      expect(s.list().map((x) => x.id)).toEqual(["t3", "t2", "t1"])
    })

    test(id(3, "restore returns the SAME frozen array"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("hello"), checkpointMsg("world")])
      const restored = s.restore("t1")
      expect(restored).not.toBeNull()
      expect(restored).toHaveLength(2)
    })

    test(id(4, "restore for unknown id returns null (no throw)"), () => {
      expect(fresh().restore("nope")).toBeNull()
    })
  })

  describe(`${h.describeLabel} — replacement semantics`, () => {
    test(id(5, "re-record same id REPLACES (not duplicates)"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("first")])
      s.record("t1", [checkpointMsg("second")])
      const all = s.list()
      expect(all).toHaveLength(1)
      expect(all[0]?.messages[0]?.content).toEqual([{ type: "text", text: "second" }])
    })

    test(id(6, "re-record same id MOVES it to newest position (LRU touch)"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      s.record("t2", [checkpointMsg("b")])
      s.record("t1", [checkpointMsg("a-v2")])
      expect(s.list().map((x) => x.id)).toEqual(["t1", "t2"])
    })

    test(id(7, "re-record updates takenAt"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      const firstTs = s.list()[0]?.takenAt ?? 0
      s.record("t1", [checkpointMsg("a-v2")])
      expect((s.list()[0]?.takenAt ?? 0) > firstTs).toBe(true)
    })
  })

  describe(`${h.describeLabel} — immutability`, () => {
    test(id(8, "caller mutating source array does NOT affect stored snapshot"), () => {
      const s = fresh()
      const source: Message[] = [checkpointMsg("a"), checkpointMsg("b")]
      s.record("t1", source)
      source.push(checkpointMsg("c"))
      source[0] = checkpointMsg("hijacked")
      const restored = s.restore("t1")
      expect(restored).toHaveLength(2)
      expect(restored?.[0]?.content).toEqual([{ type: "text", text: "a" }])
    })

    test(id(9, "stored snapshot array is frozen at the array level"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      const restored = s.restore("t1")
      expect(Object.isFrozen(restored)).toBe(true)
      expect(() => {
        ;(restored as Message[]).push(checkpointMsg("nope"))
      }).toThrow()
    })

    test(id(10, "list() does not share identity across calls"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      const first = s.list()
      const second = s.list()
      expect(first).not.toBe(second)
      expect(first).toEqual(second)
    })
  })

  describe(`${h.describeLabel} — LRU eviction`, () => {
    test(id(11, "at cap → next record evicts oldest"), () => {
      const s = fresh(3)
      s.record("t1", [checkpointMsg("a")])
      s.record("t2", [checkpointMsg("b")])
      s.record("t3", [checkpointMsg("c")])
      s.record("t4", [checkpointMsg("d")])
      expect(s.list().map((x) => x.id)).toEqual(["t4", "t3", "t2"])
    })

    test(id(12, "maxEntries=1 → only newest survives"), () => {
      const s = fresh(1)
      s.record("t1", [checkpointMsg("a")])
      s.record("t2", [checkpointMsg("b")])
      s.record("t3", [checkpointMsg("c")])
      expect(s.list()).toHaveLength(1)
      expect(s.list()[0]?.id).toBe("t3")
    })

    test(id(13, "maxEntries=0 is treated as 1 (clamped to minimum)"), () => {
      const s = h.storeAtZeroCap()
      s.record("t1", [checkpointMsg("a")])
      expect(s.list()).toHaveLength(1)
    })
  })

  describe(`${h.describeLabel} — prune & clear`, () => {
    test(id(14, "prune(keep=N) drops oldest until N remain; returns evicted count"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      s.record("t2", [checkpointMsg("b")])
      s.record("t3", [checkpointMsg("c")])
      s.record("t4", [checkpointMsg("d")])
      expect(s.prune(2)).toBe(2)
      expect(s.list().map((x) => x.id)).toEqual(["t4", "t3"])
    })

    test(id(15, "prune(keep) >= current size → no-op, returns 0"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      expect(s.prune(50)).toBe(0)
      expect(s.list()).toHaveLength(1)
    })

    test(id(16, "prune(keep=0) clears everything"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      s.record("t2", [checkpointMsg("b")])
      expect(s.prune(0)).toBe(2)
      expect(s.list()).toHaveLength(0)
    })

    test(id(17, "prune(negative) clamps to 0"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      expect(s.prune(-5)).toBe(1)
      expect(s.list()).toHaveLength(0)
    })

    test(id(18, "clear() removes everything"), () => {
      const s = fresh()
      s.record("t1", [checkpointMsg("a")])
      s.record("t2", [checkpointMsg("b")])
      s.clear()
      expect(s.list()).toHaveLength(0)
      expect(s.restore("t1")).toBeNull()
    })
  })

  describe(`${h.describeLabel} — input contract`, () => {
    test(id(19, "empty messages array is valid"), () => {
      const s = fresh()
      s.record("t1", [])
      expect(s.restore("t1")).toEqual([])
    })

    test(id(20, "non-array messages throws ConversationCheckpointError"), () => {
      const s = fresh()
      expect(() => {
        s.record("t1", "not-an-array" as unknown as Message[])
      }).toThrow(ConversationCheckpointError)
    })

    test(id(21, "empty string id is permitted"), () => {
      const s = fresh()
      s.record("", [checkpointMsg("a")])
      expect(s.restore("")).not.toBeNull()
    })
  })

  describe(`${h.describeLabel} — clock injection (determinism)`, () => {
    test(id(22, "takenAt uses injected clock verbatim"), () => {
      let n = 5_000
      const s = h.storeWithClock(() => n)
      s.record("t1", [checkpointMsg("a")])
      expect(s.list()[0]?.takenAt).toBe(5_000)
      n = 9_999
      s.record("t2", [checkpointMsg("b")])
      expect(s.list()[0]?.takenAt).toBe(9_999)
    })

    test(id(23, "default clock is Date.now (runtime sanity)"), () => {
      const s = h.storeWithDefaultClock()
      const before = Date.now()
      s.record("t1", [checkpointMsg("a")])
      const ts = s.list()[0]?.takenAt ?? 0
      const after = Date.now()
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after + 5)
    })
  })
}
