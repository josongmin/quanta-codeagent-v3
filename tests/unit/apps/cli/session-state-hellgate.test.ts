import { describe, expect, test } from "bun:test"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { type SessionState, updateSessionState } from "../../../../src/apps/cli/repl/session-state"

// Stub LLM port — never called; just satisfies the type slot.
const stubLlm: LLMPort = {
  // biome-ignore lint/suspicious/noExplicitAny: stub port for type slot only
  stream: (() => {
    throw new Error("not used in shape tests")
  }) as any,
}

const baseState = (overrides: Partial<SessionState> = {}): SessionState => ({
  cwd: "/tmp/quanta",
  llm: stubLlm,
  sessionId: undefined,
  pendingImages: [] as readonly ImageBlock[],
  history: [] as readonly Message[],
  ...overrides,
})

describe("session-state", () => {
  test("updateSessionState returns a NEW object (immutability — never mutates input)", () => {
    const prev = baseState()
    const next = updateSessionState(prev, { sessionId: "abc" })
    expect(next).not.toBe(prev)
    expect(prev.sessionId).toBeUndefined()
    expect(next.sessionId).toBe("abc")
  })

  test("partial patch — fields not in patch carry through verbatim", () => {
    const prev = baseState({ cwd: "/old", sessionId: "old-id" })
    const next = updateSessionState(prev, { cwd: "/new" })
    expect(next.cwd).toBe("/new")
    expect(next.sessionId).toBe("old-id") // untouched
    expect(next.llm).toBe(prev.llm) // reference-equal carry-through
  })

  test("empty patch produces equal but distinct object", () => {
    const prev = baseState({ sessionId: "x" })
    const next = updateSessionState(prev, {})
    expect(next).not.toBe(prev)
    expect(next).toEqual(prev)
  })

  test("history patch replaces array — does not mutate prior", () => {
    const msg1: Message = { role: "user", content: [{ type: "text", text: "first" }] }
    const msg2: Message = { role: "user", content: [{ type: "text", text: "second" }] }
    const prev = baseState({ history: [msg1] })
    const next = updateSessionState(prev, { history: [msg1, msg2] })
    expect(prev.history.length).toBe(1) // prior untouched
    expect(next.history.length).toBe(2)
    expect(next.history[0]).toBe(msg1) // shares element
    expect(next.history[1]).toBe(msg2)
  })

  test("pendingImages patch — empty array drains, full array seeds", () => {
    const img: ImageBlock = {
      type: "image",
      data: "AAA=",
      mediaType: "image/png",
    }
    const prev = baseState({ pendingImages: [img] })
    const drained = updateSessionState(prev, { pendingImages: [] })
    expect(prev.pendingImages.length).toBe(1)
    expect(drained.pendingImages.length).toBe(0)
  })

  test("chained patches — each call returns a fresh object; final is the composition", () => {
    const s0 = baseState()
    const s1 = updateSessionState(s0, { cwd: "/a" })
    const s2 = updateSessionState(s1, { sessionId: "x" })
    const s3 = updateSessionState(s2, { cwd: "/b" })
    expect(s0).not.toBe(s1)
    expect(s1).not.toBe(s2)
    expect(s2).not.toBe(s3)
    expect(s3.cwd).toBe("/b")
    expect(s3.sessionId).toBe("x")
    // Original is still pristine.
    expect(s0.cwd).toBe("/tmp/quanta")
    expect(s0.sessionId).toBeUndefined()
  })

  test("patch reference IDENTITY — same patch object reused does not leak across calls", () => {
    const patch = { cwd: "/x" }
    const a = updateSessionState(baseState(), patch)
    const b = updateSessionState(baseState(), patch)
    expect(a).not.toBe(b)
    expect(a.cwd).toBe("/x")
    expect(b.cwd).toBe("/x")
  })
})
