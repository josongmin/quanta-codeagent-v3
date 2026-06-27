/**
 * Workflow keyword nudge through the REAL agent loop (CC "ultracode" parity).
 *
 * Proves end-to-end that a hard keyword in the user's prompt makes the harness
 * splice a `run_workflow` system-reminder into the messages the MODEL actually
 * receives — but ONLY when `run_workflow` is registered (nudge-only; the gate
 * is never flipped). The ScriptedLLM records the StreamInput it was handed, so
 * the assertion reads what the model saw, not just the post-hoc transcript.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, type Tool, ToolRegistry } from "@/tool"

const txt = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Records the messages of the LAST stream() call so we can read what the
 *  model received. */
class CapturingLLM implements LLMPort {
  readonly model = "scripted-test-model"
  lastInputMessages: Message[] = []
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.lastInputMessages = [...((input as { messages?: Message[] }).messages ?? [])]
    for (const e of this.scripts.shift() ?? txt("ok")) yield e
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}

const fakeRunWorkflow = (): Tool =>
  ({
    name: "run_workflow",
    description: "Run a declarative multi-agent workflow.",
    inputSchema: z.object({}),
    isReadOnly: () => false,
    execute: async () => ({ ok: true, output: "" }),
  }) as unknown as Tool

const run = async (
  prompt: string,
  opts: { workflowRegistered: boolean },
): Promise<{ llm: CapturingLLM; outcome: Awaited<ReturnType<typeof runAgent>> }> => {
  const llm = new CapturingLLM([txt("done")])
  const tools = opts.workflowRegistered ? [...defaultTools, fakeRunWorkflow()] : [...defaultTools]
  const cfg = {
    registry: new ToolRegistry(tools),
    stream: new RecordingStream(),
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] as Message[],
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 4,
    signal: new AbortController().signal,
    llm,
    onConfirm: async () => true,
  } as unknown as AgentConfig
  const outcome = await runAgent(cfg)
  return { llm, outcome }
}

const flat = (msgs: Message[]): string =>
  msgs
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")

describe("workflow keyword nudge — real loop, nudge-only", () => {
  test("keyword + run_workflow registered ⇒ the model RECEIVES the run_workflow reminder", async () => {
    const { llm, outcome } = await run("audit this whole thing ultracode", {
      workflowRegistered: true,
    })
    expect(outcome.reason).toBe("completed")
    const seen = flat(llm.lastInputMessages)
    expect(seen).toContain("<system-reminder>")
    expect(seen).toContain("run_workflow")
  })

  test("keyword present but run_workflow NOT registered ⇒ model sees NO nudge (gate untouched)", async () => {
    const { llm, outcome } = await run("audit this whole thing ultracode", {
      workflowRegistered: false,
    })
    expect(outcome.reason).toBe("completed")
    expect(flat(llm.lastInputMessages)).not.toContain("run_workflow")
  })

  test("no keyword ⇒ no nudge even with the tool registered", async () => {
    const { llm } = await run("just fix the failing test", { workflowRegistered: true })
    expect(flat(llm.lastInputMessages)).not.toContain("multi-agent orchestration")
  })
})
