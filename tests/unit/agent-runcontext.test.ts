import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { RunContext } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/** Yields one scripted StreamEvent[] per stream() call, in order. */
class FakeLLM implements LLMPort {
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  calls = 0

  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }

  async *stream(): AsyncIterable<StreamEvent> {
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    this.calls += 1
    for (const ev of script) yield ev
  }
}

/** StreamPort double recording every emitted AgentEvent. */
class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const usageTextScript = (): StreamEvent[] => [
  { type: "text_delta", delta: "answer" },
  { type: "usage", inputTokens: 42, outputTokens: 7, cacheReadTokens: 5, model: "fake-1" },
  { type: "message_stop", stop_reason: "end_turn" },
]

const baseConfig = (
  llm: LLMPort,
  registry: ToolRegistry,
  stream: StreamPort,
  permission: PermissionContext,
): AgentConfig => ({
  llm,
  registry,
  stream,
  permission,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
})

describe("runAgent RunContext + usage bridge (RFC-0002 W-C)", () => {
  test("(a) StreamEvent usage → AgentEvent usage emitted with mapped numbers", async () => {
    const llm = new FakeLLM([usageTextScript()])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const run: RunContext = { runId: "r1" }
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, { mode: "acceptEdits" }),
      run,
    })

    expect(outcome.reason).toBe("completed")
    const usage = stream.events.find((e) => e.type === "usage")
    expect(usage).toBeDefined()
    if (usage?.type === "usage") {
      expect(usage.inputTokens).toBe(42)
      expect(usage.outputTokens).toBe(7)
      expect(usage.cacheReadTokens).toBe(5)
      expect(usage.model).toBe("fake-1")
    }
  })

  test("(b) caller's config.run object is NOT mutated (turn stays undefined)", async () => {
    const llm = new FakeLLM([usageTextScript()])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const run: RunContext = { runId: "r1" }
    await runAgent({
      ...baseConfig(llm, registry, stream, { mode: "acceptEdits" }),
      run,
    })

    expect(run.turn).toBeUndefined()
    expect(Object.keys(run)).toEqual(["runId"])
  })

  test("(c) WITHOUT config.run loop completes identically (same reason, same non-usage events)", async () => {
    const registry = new ToolRegistry(defaultTools)

    const withStream = new RecordingStream()
    const withRun = await runAgent({
      ...baseConfig(new FakeLLM([usageTextScript()]), registry, withStream, {
        mode: "acceptEdits",
      }),
      run: { runId: "r1" },
    })

    const withoutStream = new RecordingStream()
    const withoutRun = await runAgent(
      baseConfig(new FakeLLM([usageTextScript()]), registry, withoutStream, {
        mode: "acceptEdits",
      }),
    )

    expect(withoutRun.reason).toBe(withRun.reason)
    expect(withoutRun.turns).toBe(withRun.turns)

    const nonUsage = (s: RecordingStream): string[] =>
      s.events.filter((e) => e.type !== "usage").map((e) => e.type)
    expect(nonUsage(withoutStream)).toEqual(nonUsage(withStream))
    // The unconfigured run still bridges usage (bridge is independent of run).
    expect(withoutStream.events.some((e) => e.type === "usage")).toBe(true)
  })
})
