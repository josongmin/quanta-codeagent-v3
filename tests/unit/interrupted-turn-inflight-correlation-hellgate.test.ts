import { describe, expect, test } from "bun:test"
import { buildResumeMessage, captureInterruptedTurn } from "@/agent/interrupted-turn"
import type { Message } from "@/llm"

// ALBB-06 P2 — `extractInFlightTools` must correlate `tool_use` against a LATER
// `tool_result` (by `tool_use_id`). On a turn-boundary signal_abort (Ctrl+C
// between turns) the prior turn's tools ALREADY completed and the loop appended
// `{role:"user", content:[tool_result…]}` — so those tool_use blocks are NOT in
// flight. Reporting them as "did not complete" misleads the model into
// re-issuing a landed side-effecting call. Only a tool_use with NO matching
// tool_result is genuinely in flight.

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const assistantToolUse = (id: string, name: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
})

const userToolResult = (toolUseId: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }],
})

describe("ALBB-06 in-flight tool correlation", () => {
  test("COMPLETED tool (has a later tool_result) ⇒ NOT reported in flight", () => {
    // path-(a): turn-boundary abort AFTER the tool already landed its result.
    const wm: Message[] = [userText("t"), assistantToolUse("x", "write"), userToolResult("x")]
    const turn = captureInterruptedTurn(wm, "signal_abort", 1)
    // field-level: nothing in flight
    expect(turn.inFlightTools ?? []).toEqual([])
    // surface-level: the resume note must NOT mention the completed tool
    const resume = buildResumeMessage(turn)
    expect(resume).not.toContain("did not complete")
    expect(resume).not.toContain("write")
    expect(resume).not.toContain("id x")
  })

  test("PAIRED CONTROL: genuine mid-tool-call (no tool_result) ⇒ reported in flight", () => {
    const wm: Message[] = [userText("t"), assistantToolUse("y", "edit")]
    const turn = captureInterruptedTurn(wm, "signal_abort", 1)
    expect(turn.inFlightTools).toEqual([{ id: "y", name: "edit" }])
    const resume = buildResumeMessage(turn)
    expect(resume).toContain("did not complete")
    expect(resume).toContain("edit (id y)")
  })

  test("MIXED: only the unanswered tool_use is in flight", () => {
    // Last assistant emits two tool_use; one is answered, one is not.
    const wm: Message[] = [
      userText("t"),
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "read", input: {} },
          { type: "tool_use", id: "b", name: "write", input: {} },
        ],
      },
      userToolResult("a"),
    ]
    const turn = captureInterruptedTurn(wm, "signal_abort", 1)
    expect(turn.inFlightTools).toEqual([{ id: "b", name: "write" }])
  })
})
