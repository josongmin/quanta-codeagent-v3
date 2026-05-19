import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { InMemoryStore } from "@/memory"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/** FakeLLM that records every StreamInput it receives and replays scripts. */
class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  calls = 0
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    this.calls += 1
    for (const ev of script) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

describe("agent + memory integration", () => {
  test("session 1 persists, session 2 recalls (recall rides trailing system-reminder)", async () => {
    const store = new InMemoryStore()

    const llm1 = new RecordingLLM([textScript("Implemented the widget refactor successfully")])
    const out1 = await runAgent(
      cfg({
        llm: llm1,
        store,
        sessionId: "s1",
        messages: [{ role: "user", content: [{ type: "text", text: "refactor the widget" }] }],
      }),
    )
    expect(out1.reason).toBe("completed")
    expect(store.size).toBe(1)

    // Session 2: store now has the prior summary; recall should inject it.
    const llm2 = new RecordingLLM([textScript("done again")])
    await runAgent(
      cfg({
        llm: llm2,
        store,
        sessionId: "s2",
        messages: [{ role: "user", content: [{ type: "text", text: "refactor the widget more" }] }],
      }),
    )
    const input = llm2.inputs[0]
    expect(input).toBeDefined()
    // The system prompt is the byte-stable cache prefix (ADR-0003): it is the
    // caller's static system, with NO per-turn data spliced in.
    const sys = input?.system
    expect(Array.isArray(sys)).toBe(true)
    if (Array.isArray(sys)) expect(sys.map((b) => b.text).join("")).toBe("test-system")
    // Recalled memory now rides the trailing <system-reminder> user message,
    // never the cached prefix.
    const tail = input?.messages.at(-1)
    const tailText =
      tail?.role === "user"
        ? tail.content.map((b) => (b.type === "text" ? b.text : "")).join("")
        : ""
    expect(tailText).toContain("<system-reminder>")
    expect(tailText).toContain("Implemented the widget refactor successfully")
  })

  test("no store → static system is the stable prefix, nothing recalled", async () => {
    const llm = new RecordingLLM([textScript("hi")])
    await runAgent(cfg({ llm }))
    const sys = llm.inputs[0]?.system
    expect(Array.isArray(sys)).toBe(true)
    if (Array.isArray(sys)) expect(sys.map((b) => b.text).join("")).toBe("test-system")
  })

  test("compaction config path exercised end-to-end with tiny threshold", async () => {
    const store = new InMemoryStore()
    // Long seed history forces compaction at turn top.
    const big = "x".repeat(8000)
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: big }] },
      { role: "assistant", content: [{ type: "text", text: "older turn 1" }] },
      { role: "user", content: [{ type: "text", text: "more" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn 2" }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
    ]
    // scripts: [0] summary call, [1] final answer
    const llm = new RecordingLLM([textScript("SUMMARY OF HISTORY"), textScript("final answer")])
    const out = await runAgent(
      cfg({
        llm,
        store,
        sessionId: "c1",
        messages: history,
        compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
      }),
    )
    expect(out.reason).toBe("completed")
    // The turn LLM call (after the summary call) should see a compacted
    // transcript whose first message is the synthetic summary.
    const turnInput = llm.inputs[1]
    expect(turnInput).toBeDefined()
    const first = turnInput?.messages[0]
    const firstBlock = first?.content[0]
    expect(firstBlock?.type).toBe("text")
    if (firstBlock?.type === "text") {
      expect(firstBlock.text).toContain("<conversation summary>")
      expect(firstBlock.text).toContain("SUMMARY OF HISTORY")
    }
  })
})
