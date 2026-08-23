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
const human = (t: string, id: string): Message => ({ id, role: "user", content: [{ type: "text", text: t }] })

describe("PROBE2", () => {
  test("harness reminders land INSIDE the summarized prefix, rendered as [user]", async () => {
    const wm = createWorkingMemory<Message>([])
    // multi-turn session with a bounded budget of 6 turns -> reminders fire at turns 3,4,5,6
    wm.append(human("ultracode: please refactor. Never touch secrets.txt", "m0"))
    injectWorkflowKeywordNudge({ registry: { has: (n: string) => n === "run_workflow" } } as never, wm)
    for (let t = 1; t <= 6; t++) {
      injectTurnBudgetReminder({ maxTurns: 6 } as never, wm, t)
      wm.append(asst(`assistant turn ${t} ` + "y".repeat(300)))
    }
    wm.append(human("second REAL human message", "m1"))
    wm.append(asst("final " + "z".repeat(300)))

    const messages = wm.snapshot() as Message[]
    const boundary = findBoundary(messages, 2)
    console.log("TOTAL:", messages.length, "BOUNDARY:", boundary)
    console.log("PREFIX:", messages.slice(0, boundary).map((m, i) => `${i}:${m.role}#${m.id ?? "<none>"}`).join(" | "))

    const llm = new CaptureLLM()
    const res = await compactIfNeeded({ messages, llm, system: "sys", thresholdTokens: 50, keepRecentTurns: 2 })
    console.log("COMPACTED:", res.compacted, "reason" in res ? (res as {reason?:string}).reason : "")
    const p = (llm.inputs[0]!.messages[0]!.content[0] as { text: string }).text
    console.log("---- PROMPT ----")
    console.log(p.replace(/y{20,}/g, "yyy…").replace(/z{20,}/g, "zzz…"))
    console.log("---- END ----")
    console.log("[user] tag count:", (p.match(/\[user\]/g) ?? []).length)
    console.log("budget-reminder inside prompt:", p.includes("before the turn budget ends"))
    console.log("workflow-nudge inside prompt:", p.includes("run_workflow"))
    expect(p.includes("before the turn budget ends")).toBe(true)
  })
})
