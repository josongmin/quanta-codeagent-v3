/**
 * ★ CONTRACT — ADR-0300: per-tool granular checkpoint registry
 * (in-memory `ToolSnapshot` store, sibling of ADR-0124
 * `ConversationCheckpointStore`).
 *
 * 14 hellgate cases in 4 blocks:
 *
 *   A. round-trip + replace                       (HELL-A1..A3)
 *   B. LRU + per-snap caps                        (HELL-B4..B6)
 *   C. enumeration / clear / immutability         (HELL-C7..C11)
 *   D. SSOT clock + no-throw posture              (HELL-D12..D14)
 *
 * Hermetic: NO real I/O. Only `Map`, `Object.freeze`, injected clocks.
 */

import { describe, expect, test } from "bun:test"
import type { ToolSnapshot } from "@/agent/checkpoint/granular-registry"
import { defaultGranularRegistry } from "@/agent/checkpoint/granular-registry"
import type { Message } from "@/llm"

const msg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

const baseSnap = (overrides: Partial<ToolSnapshot> = {}): ToolSnapshot => ({
  toolCallId: "tc-1",
  turn: 1,
  takenAt: 1, // overwritten by registry's injected clock
  filesBefore: new Map<string, string>([["a.txt", "alpha"]]),
  taskMessagesBefore: [msg("user", "hi")],
  ...overrides,
})

describe("granular-registry — A: round-trip + replace", () => {
  test("HELL-A1: fresh registry — restore(unknown) returns null", () => {
    const r = defaultGranularRegistry()
    expect(r.restore("nope")).toBeNull()
    expect(r.list()).toEqual([])
  })

  test("HELL-A2: record then restore round-trips the snap (same id)", () => {
    const r = defaultGranularRegistry({ now: () => 42 })
    const snap = baseSnap({ toolCallId: "tc-A2" })
    const res = r.record(snap)
    expect(res).toEqual({ ok: true })
    const got = r.restore("tc-A2")
    expect(got).not.toBeNull()
    expect(got?.toolCallId).toBe("tc-A2")
    expect(got?.turn).toBe(1)
    expect(got?.takenAt).toBe(42) // injected clock
    expect(got?.filesBefore.get("a.txt")).toBe("alpha")
    expect(got?.taskMessagesBefore).toHaveLength(1)
  })

  test("HELL-A3: same-id record REPLACES (takenAt updated + content swapped)", () => {
    let t = 100
    const r = defaultGranularRegistry({ now: () => t })
    r.record(baseSnap({ toolCallId: "tc-A3", filesBefore: new Map([["x", "v1"]]) }))
    t = 200
    r.record(
      baseSnap({
        toolCallId: "tc-A3",
        filesBefore: new Map([["x", "v2"]]),
      }),
    )
    const got = r.restore("tc-A3")
    expect(got?.takenAt).toBe(200)
    expect(got?.filesBefore.get("x")).toBe("v2")
    expect(r.list()).toHaveLength(1)
  })
})

describe("granular-registry — B: LRU + per-snap caps", () => {
  test("HELL-B4: LRU eviction at maxEntries=3 — record 4 drops oldest", () => {
    let t = 0
    const r = defaultGranularRegistry({ maxEntries: 3, now: () => ++t })
    r.record(baseSnap({ toolCallId: "id1" }))
    r.record(baseSnap({ toolCallId: "id2" }))
    r.record(baseSnap({ toolCallId: "id3" }))
    r.record(baseSnap({ toolCallId: "id4" }))
    const ids = r.list().map((e) => e.toolCallId)
    expect(ids).toEqual(["id4", "id3", "id2"]) // newest-first; id1 evicted
    expect(r.restore("id1")).toBeNull()
    expect(r.restore("id4")?.toolCallId).toBe("id4")
  })

  test("HELL-B5: filesBefore.size > maxFilesPerSnap → ok:false 'over-cap', not inserted", () => {
    const r = defaultGranularRegistry({ maxFilesPerSnap: 2 })
    const files = new Map<string, string>([
      ["a", "x"],
      ["b", "x"],
      ["c", "x"], // 3 > 2
    ])
    const res = r.record(baseSnap({ toolCallId: "over-files", filesBefore: files }))
    expect(res).toEqual({ ok: false, reason: "over-cap" })
    expect(r.restore("over-files")).toBeNull()
    expect(r.list()).toHaveLength(0)
  })

  test("HELL-B6: sum bytes > maxBytesPerSnap → ok:false 'over-cap', not inserted", () => {
    // maxBytes=10 ; one file of length 11 should fail
    const r = defaultGranularRegistry({ maxBytesPerSnap: 10 })
    const files = new Map<string, string>([["big", "0123456789A"]]) // 11 chars
    const res = r.record(baseSnap({ toolCallId: "over-bytes", filesBefore: files }))
    expect(res).toEqual({ ok: false, reason: "over-cap" })
    expect(r.restore("over-bytes")).toBeNull()

    // Sum across files also enforced.
    const files2 = new Map<string, string>([
      ["a", "12345"],
      ["b", "67890"],
      ["c", "X"], // total 11 > 10
    ])
    const res2 = r.record(baseSnap({ toolCallId: "sum-over", filesBefore: files2 }))
    expect(res2).toEqual({ ok: false, reason: "over-cap" })
  })
})

describe("granular-registry — C: enumeration / clear / immutability", () => {
  test("HELL-C7: list() returns most-recent-first", () => {
    let t = 0
    const r = defaultGranularRegistry({ now: () => ++t })
    r.record(baseSnap({ toolCallId: "first" }))
    r.record(baseSnap({ toolCallId: "second" }))
    r.record(baseSnap({ toolCallId: "third" }))
    const ids = r.list().map((e) => e.toolCallId)
    expect(ids).toEqual(["third", "second", "first"])
  })

  test("HELL-C8: clear() empties everything", () => {
    const r = defaultGranularRegistry()
    r.record(baseSnap({ toolCallId: "x" }))
    r.record(baseSnap({ toolCallId: "y" }))
    expect(r.list()).toHaveLength(2)
    r.clear()
    expect(r.list()).toHaveLength(0)
    expect(r.restore("x")).toBeNull()
    expect(r.restore("y")).toBeNull()
  })

  test("HELL-C9: empty filesBefore + empty taskMessagesBefore is valid", () => {
    const r = defaultGranularRegistry()
    const res = r.record(
      baseSnap({
        toolCallId: "empty",
        filesBefore: new Map(),
        taskMessagesBefore: [],
      }),
    )
    expect(res).toEqual({ ok: true })
    const got = r.restore("empty")
    expect(got?.filesBefore.size).toBe(0)
    expect(got?.taskMessagesBefore).toHaveLength(0)
  })

  test("HELL-C10: messages array returned by restore is frozen", () => {
    const r = defaultGranularRegistry()
    r.record(
      baseSnap({
        toolCallId: "frozen",
        taskMessagesBefore: [msg("user", "m1"), msg("assistant", "m2")],
      }),
    )
    const got = r.restore("frozen")
    expect(got).not.toBeNull()
    expect(Object.isFrozen(got?.taskMessagesBefore)).toBe(true)
  })

  test("HELL-C11: messages array is a COPY — mutating caller's array does not affect restore", () => {
    const r = defaultGranularRegistry()
    const callerMessages: Message[] = [msg("user", "original")]
    r.record(baseSnap({ toolCallId: "copy", taskMessagesBefore: callerMessages }))
    callerMessages.push(msg("assistant", "post-record-push"))
    callerMessages[0] = msg("user", "post-record-overwrite")
    const got = r.restore("copy")
    // Inner Message objects are caller-owned (not deep-frozen, matches
    // ConversationCheckpointStore posture), but the ARRAY reference is
    // immutable: post-record mutation of caller's array doesn't grow the
    // snapshot.
    expect(got?.taskMessagesBefore).toHaveLength(1)
  })
})

describe("granular-registry — D: SSOT clock + no-throw", () => {
  test("HELL-D12: injected `now` is SSOT — Date.now never consulted", () => {
    let calls = 0
    const fakeNow = () => {
      calls += 1
      return 9999
    }
    // Sabotage Date.now to expose any sneaky fall-through.
    const realDateNow = Date.now
    Date.now = () => {
      throw new Error("Date.now must not be called when `now` is injected")
    }
    try {
      const r = defaultGranularRegistry({ now: fakeNow })
      r.record(baseSnap({ toolCallId: "ssot" }))
      const got = r.restore("ssot")
      expect(got?.takenAt).toBe(9999)
      expect(calls).toBeGreaterThan(0)
    } finally {
      Date.now = realDateNow
    }
  })

  test("HELL-D13: record then clear then record same-id → fresh entry", () => {
    let t = 1
    const r = defaultGranularRegistry({ now: () => t })
    r.record(baseSnap({ toolCallId: "reset", filesBefore: new Map([["a", "v1"]]) }))
    expect(r.list()).toHaveLength(1)
    r.clear()
    expect(r.list()).toHaveLength(0)
    t = 2
    r.record(baseSnap({ toolCallId: "reset", filesBefore: new Map([["a", "v2"]]) }))
    const got = r.restore("reset")
    expect(got?.takenAt).toBe(2)
    expect(got?.filesBefore.get("a")).toBe("v2")
  })

  test("HELL-D14: NO-THROW — feeding weird inputs (turn: -1, empty id) does not throw", () => {
    const r = defaultGranularRegistry()
    // Weird turn is recorded as-is; validation is caller's job.
    expect(() => r.record(baseSnap({ toolCallId: "weird", turn: -1 }))).not.toThrow()
    expect(r.restore("weird")?.turn).toBe(-1)
    // Empty id permitted (discouraged but not rejected — matches
    // ConversationCheckpointStore posture).
    expect(() => r.record(baseSnap({ toolCallId: "" }))).not.toThrow()
    expect(r.restore("")?.toolCallId).toBe("")
  })
})
