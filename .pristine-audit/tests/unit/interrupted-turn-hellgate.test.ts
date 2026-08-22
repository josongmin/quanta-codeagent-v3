import { describe, expect, test } from "bun:test"
import {
  buildResumeMessage,
  captureInterruptedTurn,
  createInterruptedTurnBuffer,
  type InterruptedTurn,
} from "@/agent/interrupted-turn"
import type { Message } from "@/llm"

// §11.5 — interrupted-turn CAPTURE + RESTORE hellgate. When `interrupt` mode (or
// /cancel) aborts a turn mid-flight, the partial work must be CAPTURED into a
// session buffer so a later `resume` can restore it (Claude's INTERRUPTED_TURN
// pattern). Pure core pinned here: capture extracts the originating prompt +
// partial assistant text from working memory; the buffer is a single-slot
// last-interrupt-wins store; resume consumes it (take() clears).

const msg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

describe("captureInterruptedTurn", () => {
  test("extracts the last user prompt + partial assistant text after it", () => {
    const wm: Message[] = [
      msg("user", "first task"),
      msg("assistant", "did first"),
      msg("user", "the interrupted task"),
      msg("assistant", "partial work so far"),
    ]
    const t = captureInterruptedTurn(wm, "user barge-in", 1000)
    expect(t.userText).toBe("the interrupted task")
    expect(t.partialAssistantText).toBe("partial work so far")
    expect(t.reason).toBe("user barge-in")
    expect(t.interruptedAt).toBe(1000)
  })

  test("concatenates multiple assistant blocks after the last user message", () => {
    const wm: Message[] = [
      msg("user", "go"),
      msg("assistant", "step 1"),
      msg("assistant", "step 2"),
    ]
    const t = captureInterruptedTurn(wm, "r", 1)
    expect(t.userText).toBe("go")
    expect(t.partialAssistantText).toBe("step 1\nstep 2")
  })

  test("no assistant work yet ⇒ empty partial (interrupted before any output)", () => {
    const wm: Message[] = [msg("user", "just started")]
    const t = captureInterruptedTurn(wm, "r", 1)
    expect(t.userText).toBe("just started")
    expect(t.partialAssistantText).toBe("")
  })

  test("no user message ⇒ empty userText (defensive, never throws)", () => {
    const t = captureInterruptedTurn([msg("assistant", "orphan")], "r", 1)
    expect(t.userText).toBe("")
  })
})

describe("InterruptedTurnBuffer", () => {
  test("empty buffer: has=false, peek/take=null", () => {
    const b = createInterruptedTurnBuffer()
    expect(b.has()).toBe(false)
    expect(b.peek()).toBeNull()
    expect(b.take()).toBeNull()
  })

  test("capture → has=true; peek does NOT consume; take consumes (clears)", () => {
    const b = createInterruptedTurnBuffer()
    const t: InterruptedTurn = {
      userText: "x",
      partialAssistantText: "p",
      reason: "r",
      interruptedAt: 1,
    }
    b.capture(t)
    expect(b.has()).toBe(true)
    expect(b.peek()).toEqual(t)
    expect(b.has()).toBe(true) // peek did not consume
    expect(b.take()).toEqual(t)
    expect(b.has()).toBe(false) // take consumed
    expect(b.take()).toBeNull()
  })

  test("last-interrupt-wins: a second capture overwrites the first", () => {
    const b = createInterruptedTurnBuffer()
    b.capture({ userText: "a", partialAssistantText: "", reason: "r", interruptedAt: 1 })
    b.capture({ userText: "b", partialAssistantText: "", reason: "r", interruptedAt: 2 })
    expect(b.take()?.userText).toBe("b")
  })

  test("clear empties the buffer", () => {
    const b = createInterruptedTurnBuffer()
    b.capture({ userText: "a", partialAssistantText: "", reason: "r", interruptedAt: 1 })
    b.clear()
    expect(b.has()).toBe(false)
  })
})

describe("buildResumeMessage", () => {
  test("re-states the interrupted task + the partial progress", () => {
    const m = buildResumeMessage({
      userText: "refactor the parser",
      partialAssistantText: "started extracting the tokenizer",
      reason: "user barge-in",
      interruptedAt: 1,
    })
    expect(m).toContain("refactor the parser")
    expect(m).toContain("started extracting the tokenizer")
    // It is framed as a resume directive (not a fresh task).
    expect(m.toLowerCase()).toContain("resume")
  })

  test("no partial progress ⇒ message still references the task, omits empty progress", () => {
    const m = buildResumeMessage({
      userText: "build X",
      partialAssistantText: "",
      reason: "r",
      interruptedAt: 1,
    })
    expect(m).toContain("build X")
    expect(m.toLowerCase()).toContain("resume")
  })
})
