import { describe, expect, test } from "bun:test"
import { compactIfNeeded, findBoundary } from "@/agent/compaction"
import { injectTurnBudgetReminder } from "@/agent/loop/turn-iteration"
import { injectWorkflowKeywordNudge } from "@/agent/workflow-keyword"
import { createWorkingMemory } from "@/memory/working"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"

class CaptureLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  readonly model = "capture"
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    yield { type: "text_delta", text: "SUMMARY" } as StreamEvent
  }
}

const asst = (t: string): Message => ({ role: "assistant", content: [{ type: "text", text: t }] })
const human = (t: string): Message => ({ id: "m0", role: "user", content: [{ type: "text", text: t }] })

describe("PROBE", () => {
  test("real injectTurnBudgetReminder produces an UNTAGGED role:user message", () => {
    const wm = createWorkingMemory<Message>([])
    injectTurnBudgetReminder({ maxTurns: 10 } as never, wm, 9)
    const all = wm.snapshot()
    console.log("BUDGET REMINDER MSG:", JSON.stringify(all))
    expect(all.length).toBe(1)
    expect((all[0] as Message).id).toBeUndefined()
  })

  test("real injectWorkflowKeywordNudge is UNTAGGED", () => {
    const wm = createWorkingMemory<Message>([human("please run the workflow for this")])
    injectWorkflowKeywordNudge(
      { registry: { has: (n: string) => n === "run_workflow" } } as never,
      wm,
    )
    const all = wm.snapshot() as Message[]
    console.log("NUDGE COUNT:", all.length, JSON.stringify(all.slice(1)))
  })

  test("CONSEQUENCE: untagged harness reminder lands in summarized prefix and renders as [user]", async () => {
    const wm = createWorkingMemory<Message>([human("HUMAN_GENUINE_PROMPT do not touch secrets.txt")])
    for (let t = 0; t < 8; t++) {
      wm.append(asst(`assistant turn ${t} ` + "x".repeat(200)))
      injectTurnBudgetReminder({ maxTurns: 10 } as never, wm, t + 2)
    }
    const messages = wm.snapshot() as Message[]
    const boundary = findBoundary(messages, 2)
    const prefix = messages.slice(0, boundary)
    console.log("TOTAL:", messages.length, "BOUNDARY:", boundary, "PREFIX LEN:", prefix.length)
    console.log("PREFIX ROLES:", prefix.map((m) => `${m.role}${m.id ? `#${m.id}` : "#<none>"}`).join(", "))

    const llm = new CaptureLLM()
    const res = await compactIfNeeded({ messages, llm, system: "sys", thresholdTokens: 50, keepRecentTurns: 2 })
    console.log("COMPACTED:", res.compacted)
    const promptText = (llm.inputs[0]!.messages[0]!.content[0] as { text: string }).text
    console.log("---- SUMMARIZER PROMPT (verbatim) ----")
    console.log(promptText)
    console.log("---- END ----")
    const userTags = (promptText.match(/\[user\]/g) ?? []).length
    console.log("COUNT OF [user] TAGS IN PROMPT:", userTags)
    expect(userTags).toBeGreaterThan(1)
  })
})
