/**
 * FIX 1 (HELLGATE) — `captureInterruptedTurn` must skip pure `tool_result`
 * user messages when picking the originating task prompt. After a tools turn
 * the loop appends `{role:"user", content:[tool_result…]}` (turn-outcome.ts),
 * whose `textOf` is "" — the naive "last user message" pick captured that empty
 * message and the resume body silently lost the task.
 */

import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import { buildResumeMessage, captureInterruptedTurn } from "../interrupted-turn"

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const toolResultUser = (id: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }],
})

describe("captureInterruptedTurn — task prompt capture", () => {
  test("skips a trailing pure tool_result user message and picks the real prompt", () => {
    const messages: Message[] = [
      userText("Fix the failing test in foo.py"),
      assistantText("I will run the tests"),
      toolResultUser("call-1"),
    ]
    const cap = captureInterruptedTurn(messages, "user cancel", 1000)

    expect(cap.userText).toBe("Fix the failing test in foo.py")
    // partial progress = assistant text AFTER the chosen user message
    expect(cap.partialAssistantText).toBe("I will run the tests")

    const body = buildResumeMessage(cap)
    expect(body).toContain("Fix the failing test in foo.py")
    // the resume body must NOT be an empty "The task was:\n" tail
    expect(body).not.toMatch(/The task was:\s*$/)
  })

  test("skips MULTIPLE trailing tool_result user messages (parallel tools)", () => {
    const messages: Message[] = [
      userText("Refactor the parser"),
      assistantText("dispatching two tools"),
      toolResultUser("call-a"),
      toolResultUser("call-b"),
    ]
    const cap = captureInterruptedTurn(messages, "interrupt", 5)
    expect(cap.userText).toBe("Refactor the parser")
    expect(cap.partialAssistantText).toBe("dispatching two tools")
  })

  test("partial scan uses assistant messages AFTER the chosen user message only", () => {
    const messages: Message[] = [
      userText("first task"),
      assistantText("stale progress on first"),
      userText("real task"),
      assistantText("progress A"),
      toolResultUser("c1"),
      assistantText("progress B"),
    ]
    const cap = captureInterruptedTurn(messages, "x", 0)
    expect(cap.userText).toBe("real task")
    // both assistant messages after the chosen user msg, none before it
    expect(cap.partialAssistantText).toBe("progress A\nprogress B")
    expect(cap.partialAssistantText).not.toContain("stale progress")
  })

  test("no user text anywhere ⇒ empty userText (defensive, unchanged)", () => {
    const messages: Message[] = [toolResultUser("c1"), assistantText("orphan")]
    const cap = captureInterruptedTurn(messages, "x", 0)
    expect(cap.userText).toBe("")
  })

  test("regression: a normal trailing user prompt is still captured", () => {
    const messages: Message[] = [assistantText("earlier"), userText("do the thing")]
    const cap = captureInterruptedTurn(messages, "x", 0)
    expect(cap.userText).toBe("do the thing")
    expect(cap.partialAssistantText).toBe("")
  })

  test("skips a WHITESPACE-ONLY trailing user message and picks the real prompt", () => {
    // A blank/steer-injected user turn (only whitespace) must not shadow the real
    // earlier prompt — else the resume body is `The task was:\n   ` (task lost).
    const messages: Message[] = [
      userText("Implement the feature"),
      assistantText("working"),
      userText("   \n\t "),
    ]
    const cap = captureInterruptedTurn(messages, "x", 0)
    expect(cap.userText).toBe("Implement the feature")
    expect(cap.partialAssistantText).toBe("working")
    expect(buildResumeMessage(cap)).not.toMatch(/The task was:\s*$/)
  })
})
