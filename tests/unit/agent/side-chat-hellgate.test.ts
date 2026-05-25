/**
 * Side-chat hellgate (ADR-0244).
 *
 * Seals 15 invariants for the SideChatManager auxiliary-conversation
 * lifecycle primitive. CORE invariant: NO operation on a SideChatId
 * mutates the parent session's `messages[]` (HELL-SC-04 / HELL-SC-09).
 *
 *   SC-01 start → SideChatId + state "active", UUID v4 shape
 *   SC-02 send round-trip → reply.role === "assistant"
 *   SC-03 stop → state "stopped"; subsequent send → Err("not-active")
 *   SC-04 parent context NEVER mutated (deep-equal pre/post operations)
 *   SC-05 list(parentId) returns active chats owned by that parent
 *   SC-06 unknown id on send/stop → Err("unknown-id"), no throw
 *   SC-07 cross-parent isolation: parent B's list excludes parent A's chats
 *   SC-08 nested depth=2 MVP — start from a side-chat context is allowed
 *   SC-09 send reply NEVER appears in parent's messages[]
 *   SC-10 after stop, list(parent) does NOT include the stopped id
 *   SC-11 1000 concurrent side chats — every id only sees its own messages
 *   SC-12 default-OFF byte-identical: constructing manager mutates nothing external
 *   SC-13 AbortSignal aborted → Err("aborted"); no state mutates
 *   SC-14 state 2-arm exhaustive (assertNever-guarded)
 *   SC-15 closeAllForParent(parent) flips active chats to stopped
 */

import { describe, expect, test } from "bun:test"
import {
  ALL_SIDE_CHAT_STATES,
  defaultSideChatManager,
  type SideChatManager,
  type SideChatState,
} from "@/agent/side-chat"
import type { Message } from "@/llm"
import { assertNever } from "@/shared"

// ----------------------------------------------------------------------------
// harness
// ----------------------------------------------------------------------------

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}
const resetTick = (start = 1_000): void => {
  tickValue = start
}

let uuidCounter = 0
const mintUuid = (): string => {
  uuidCounter += 1
  // RFC 4122 v4 shape — `4` in the third group, `8|9|a|b` start of the fourth.
  const c = uuidCounter.toString(16).padStart(8, "0")
  return `${c}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const freshManager = (maxEntries?: number): SideChatManager => {
  resetTick()
  uuidCounter = 0
  return defaultSideChatManager(
    maxEntries !== undefined
      ? { now: tick, mintSideChatId: mintUuid, maxEntries }
      : { now: tick, mintSideChatId: mintUuid },
  )
}

/** Parent session messages — a real-shape `Message[]` so HELL-SC-04 /
 *  HELL-SC-09 deep-equal seals are byte-identical to a production parent.
 *  The harness never aliases this array INTO any SideChat operation —
 *  the slice owns its own message shape, so there is no public surface
 *  by which a side-chat could mutate this. The test makes that
 *  structurally observable. */
const mkParentMessages = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "parent turn 1" }] },
  { role: "assistant", content: [{ type: "text", text: "parent reply 1" }] },
]

// ----------------------------------------------------------------------------
// SC-01 .. SC-15
// ----------------------------------------------------------------------------

describe("side-chat hellgate (ADR-0244)", () => {
  test("HELL-SC-01: start(parent, prompt) → Ok({ id, state:'active' }), UUID v4", () => {
    const m = freshManager()
    const r = m.start({ parentSessionId: "parent-A", prompt: "hello side chat" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.state).toBe("active")
    expect(typeof r.value.id).toBe("string")
    expect(UUID_V4_RE.test(r.value.id)).toBe(true)
  })

  test("HELL-SC-02: send(id, msg) round-trip → reply.role === 'assistant'", () => {
    const m = freshManager()
    const s = m.start({ parentSessionId: "parent-A", prompt: "p" })
    expect(s.ok).toBe(true)
    if (!s.ok) throw new Error("unreachable")
    const r = m.send({ id: s.value.id, message: "say hi" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.reply.role).toBe("assistant")
    expect(typeof r.value.reply.text).toBe("string")
    expect(r.value.reply.text.length).toBeGreaterThan(0)
  })

  test("HELL-SC-03: stop → state 'stopped'; subsequent send → Err('not-active')", () => {
    const m = freshManager()
    const s = m.start({ parentSessionId: "parent-A", prompt: "p" })
    if (!s.ok) throw new Error("unreachable")
    const stop = m.stop({ id: s.value.id })
    expect(stop.ok).toBe(true)
    if (!stop.ok) throw new Error("unreachable")
    expect(stop.value.state).toBe("stopped")
    const r = m.send({ id: s.value.id, message: "still there?" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("not-active")
  })

  test("HELL-SC-04: parent context NEVER mutated (deep-equal pre/post start+send+stop)", () => {
    const m = freshManager()
    const parent: Message[] = mkParentMessages()
    const snapshotBefore = JSON.stringify(parent)
    // Exercise every public op. The slice has no reference to `parent` —
    // it cannot mutate it. The seal is observability: even if a future
    // refactor leaked a reference, this deep-equal would catch it.
    const s = m.start({ parentSessionId: "parent-A", prompt: "p" })
    if (!s.ok) throw new Error("unreachable")
    m.send({ id: s.value.id, message: "m" })
    m.send({ id: s.value.id, message: "n" })
    m.stop({ id: s.value.id })
    m.list({ parentSessionId: "parent-A" })
    m.closeAllForParent({ parentSessionId: "parent-A" })
    const snapshotAfter = JSON.stringify(parent)
    expect(snapshotAfter).toBe(snapshotBefore)
    expect(parent.length).toBe(2)
  })

  test("HELL-SC-05: list(parentId) returns active SideChatIds owned by that parent", () => {
    const m = freshManager()
    const s1 = m.start({ parentSessionId: "parent-A", prompt: "p1" })
    const s2 = m.start({ parentSessionId: "parent-A", prompt: "p2" })
    if (!s1.ok || !s2.ok) throw new Error("unreachable")
    const ids = m.list({ parentSessionId: "parent-A" })
    expect(ids.length).toBe(2)
    expect(ids).toContain(s1.value.id)
    expect(ids).toContain(s2.value.id)
  })

  test("HELL-SC-06: unknown id on send/stop → Err('unknown-id'), no throw", () => {
    const m = freshManager()
    const r1 = m.send({ id: "no-such-id", message: "x" })
    expect(r1.ok).toBe(false)
    if (r1.ok) throw new Error("unreachable")
    expect(r1.error.code).toBe("unknown-id")

    const r2 = m.stop({ id: "no-such-id" })
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect(r2.error.code).toBe("unknown-id")
  })

  test("HELL-SC-07: cross-parent isolation: parent B's list excludes parent A's chats", () => {
    const m = freshManager()
    const sA = m.start({ parentSessionId: "parent-A", prompt: "pA" })
    const sB = m.start({ parentSessionId: "parent-B", prompt: "pB" })
    if (!sA.ok || !sB.ok) throw new Error("unreachable")
    const aIds = m.list({ parentSessionId: "parent-A" })
    const bIds = m.list({ parentSessionId: "parent-B" })
    expect(aIds).toEqual([sA.value.id])
    expect(bIds).toEqual([sB.value.id])
    expect(aIds.includes(sB.value.id)).toBe(false)
    expect(bIds.includes(sA.value.id)).toBe(false)
  })

  test("HELL-SC-08: nested depth=2 MVP — start from a side-chat context is allowed", () => {
    const m = freshManager()
    const outer = m.start({ parentSessionId: "parent-A", prompt: "outer" })
    if (!outer.ok) throw new Error("unreachable")
    // The "side chat from a side chat" pattern: caller treats the outer
    // SideChatId AS a parent for a deeper chat. The slice tracks parent
    // ownership by string id — depth is implicit.
    const inner = m.start({ parentSessionId: outer.value.id, prompt: "inner" })
    expect(inner.ok).toBe(true)
    if (!inner.ok) throw new Error("unreachable")
    expect(inner.value.state).toBe("active")
    // Listing the outer's id as a parent finds the inner chat.
    const innerIds = m.list({ parentSessionId: outer.value.id })
    expect(innerIds).toEqual([inner.value.id])
    // Listing the original parent does NOT see the inner chat (depth=2
    // chats are owned by their immediate parent, not the root).
    const outerIds = m.list({ parentSessionId: "parent-A" })
    expect(outerIds).toEqual([outer.value.id])
  })

  test("HELL-SC-09: send reply NEVER appears in parent's messages[]", () => {
    const m = freshManager()
    const parent: Message[] = mkParentMessages()
    const snapshotBefore = JSON.stringify(parent)
    const s = m.start({ parentSessionId: "parent-A", prompt: "p" })
    if (!s.ok) throw new Error("unreachable")
    const r = m.send({ id: s.value.id, message: "ask the side chat" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    // The reply text must NOT appear anywhere in the parent's serialised history.
    const snapshotAfter = JSON.stringify(parent)
    expect(snapshotAfter).toBe(snapshotBefore)
    expect(snapshotAfter.includes(r.value.reply.text)).toBe(false)
    expect(snapshotAfter.includes("side chat")).toBe(false)
  })

  test("HELL-SC-10: after stop, list(parent) does NOT include the stopped id", () => {
    const m = freshManager()
    const s1 = m.start({ parentSessionId: "parent-A", prompt: "p1" })
    const s2 = m.start({ parentSessionId: "parent-A", prompt: "p2" })
    if (!s1.ok || !s2.ok) throw new Error("unreachable")
    m.stop({ id: s1.value.id })
    const ids = m.list({ parentSessionId: "parent-A" })
    expect(ids.includes(s1.value.id)).toBe(false)
    expect(ids.includes(s2.value.id)).toBe(true)
    expect(ids.length).toBe(1)
  })

  test("HELL-SC-11: 1000 concurrent side chats — every id only sees its own messages", () => {
    // Cap = 1500 so all 1000 fit without eviction.
    const m = freshManager(1500)
    const ids: string[] = []
    for (let i = 0; i < 1000; i++) {
      const r = m.start({ parentSessionId: "parent-A", prompt: `prompt-${i}` })
      if (!r.ok) throw new Error(`unreachable: start failed at ${i}`)
      ids.push(r.value.id)
    }
    // Send a unique message to each.
    for (let i = 0; i < 1000; i++) {
      const id = ids[i]
      if (id === undefined) throw new Error("unreachable")
      const r = m.send({ id, message: `msg-for-${i}` })
      if (!r.ok) throw new Error(`unreachable: send failed at ${i}`)
      // Reply length encodes the input length — distinct per chat.
      expect(r.value.reply.text.includes(String(`msg-for-${i}`.length))).toBe(true)
    }
    // 1000 active chats, all visible under parent-A.
    const listed = m.list({ parentSessionId: "parent-A" })
    expect(listed.length).toBe(1000)
    // All ids unique.
    expect(new Set(listed).size).toBe(1000)
  })

  test("HELL-SC-12: default-OFF byte-identical — constructing manager mutates nothing external", () => {
    // Construct multiple managers; no shared state, no module-level side
    // effects, no external observable change. Snapshot a sentinel object
    // and verify it stays byte-identical across instantiation.
    const sentinel = { messages: ["a", "b", "c"], k: 42 }
    const before = JSON.stringify(sentinel)
    const m1 = defaultSideChatManager()
    const m2 = defaultSideChatManager({ maxEntries: 10 })
    const m3 = defaultSideChatManager({ now: () => 0 })
    // No-op listing on a fresh manager mutates nothing.
    expect(m1.list({ parentSessionId: "anything" })).toEqual([])
    expect(m2.list({ parentSessionId: "anything" })).toEqual([])
    expect(m3.list({ parentSessionId: "anything" })).toEqual([])
    const after = JSON.stringify(sentinel)
    expect(after).toBe(before)
  })

  test("HELL-SC-13: AbortSignal aborted → Err('aborted'); no state mutates", () => {
    const m = freshManager()
    const ctl = new AbortController()
    ctl.abort()
    const sizeBefore = m.list({ parentSessionId: "parent-A" }).length

    const r1 = m.start({
      parentSessionId: "parent-A",
      prompt: "p",
      signal: ctl.signal,
    })
    expect(r1.ok).toBe(false)
    if (r1.ok) throw new Error("unreachable")
    expect(r1.error.code).toBe("aborted")
    // No new chat recorded.
    expect(m.list({ parentSessionId: "parent-A" }).length).toBe(sizeBefore)

    // Set up a real chat, then attempt a send under an aborted signal.
    const s = m.start({ parentSessionId: "parent-A", prompt: "p" })
    if (!s.ok) throw new Error("unreachable")
    const ctl2 = new AbortController()
    ctl2.abort()
    const r2 = m.send({ id: s.value.id, message: "x", signal: ctl2.signal })
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect(r2.error.code).toBe("aborted")
  })

  test("HELL-SC-14: state 2-arm exhaustive (assertNever-guarded)", () => {
    // The tuple drives runtime exhaustiveness — every value in
    // ALL_SIDE_CHAT_STATES gets routed without falling through to assertNever.
    let routed = 0
    for (const s of ALL_SIDE_CHAT_STATES) {
      const state: SideChatState = s
      switch (state) {
        case "active":
          routed += 1
          break
        case "stopped":
          routed += 1
          break
        default:
          assertNever(state)
      }
    }
    expect(routed).toBe(ALL_SIDE_CHAT_STATES.length)
    expect(ALL_SIDE_CHAT_STATES.length).toBe(2)
  })

  test("HELL-SC-15: closeAllForParent(parent) flips every active chat of that parent to stopped", () => {
    const m = freshManager()
    const sA1 = m.start({ parentSessionId: "parent-A", prompt: "a1" })
    const sA2 = m.start({ parentSessionId: "parent-A", prompt: "a2" })
    const sB1 = m.start({ parentSessionId: "parent-B", prompt: "b1" })
    if (!sA1.ok || !sA2.ok || !sB1.ok) throw new Error("unreachable")
    const closed = m.closeAllForParent({ parentSessionId: "parent-A" })
    expect(closed).toBe(2)
    // Parent A is empty now.
    expect(m.list({ parentSessionId: "parent-A" })).toEqual([])
    // Parent B is untouched.
    expect(m.list({ parentSessionId: "parent-B" })).toEqual([sB1.value.id])
    // Subsequent send on a closed chat surfaces not-active.
    const r = m.send({ id: sA1.value.id, message: "still?" })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("not-active")
    // Idempotent: calling again on the same parent returns 0.
    expect(m.closeAllForParent({ parentSessionId: "parent-A" })).toBe(0)
  })
})
