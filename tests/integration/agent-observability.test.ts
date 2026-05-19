import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import { isTrajectoryEvent, type RunContext } from "@/shared"
import { type AgentEvent, JsonlRecorder, type StreamPort, TeeStream } from "@/stream"
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

const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "usage", inputTokens: 100, outputTokens: 20, model: "fake-1" },
  { type: "message_stop", stop_reason: "tool_use" },
]

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "usage", inputTokens: 110, outputTokens: 4, model: "fake-1" },
  { type: "message_stop", stop_reason: "end_turn" },
]

const baseConfig = (
  llm: LLMPort,
  registry: ToolRegistry,
  stream: StreamPort,
  cwd: string,
  permission: PermissionContext,
  run: RunContext,
): AgentConfig => ({
  llm,
  registry,
  stream,
  permission,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd,
  maxTurns: 10,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  run,
})

describe("runAgent observability trajectory (RFC-0002 W-C)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-observe-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("real JsonlRecorder via TeeStream captures a coherent trajectory", async () => {
    const file = join(dir, "out.txt")
    const llm = new FakeLLM([
      toolUseScript("c1", "write", { path: file, content: "hi" }),
      textScript("done"),
    ])
    const recording = new RecordingStream()
    const runId = "run-fixed"
    const recorder = new JsonlRecorder(join(dir, runId, "session.jsonl"), {
      ctx: { runId },
      now: () => 1_700_000_000_000,
    })
    const tee = new TeeStream([recording, recorder])
    const registry = new ToolRegistry(defaultTools)

    const outcome = await runAgent(
      baseConfig(llm, registry, tee, dir, { mode: "acceptEdits" }, { runId }),
    )
    recorder.close()

    expect(outcome.reason).toBe("completed")
    expect(outcome.turns).toBe(2)

    const raw = readFileSync(join(dir, runId, "session.jsonl"), "utf8").trim()
    const lines = raw.split("\n").map((l) => JSON.parse(l) as unknown)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(isTrajectoryEvent(l)).toBe(true)

    const kinds = lines.map((l) => (l as { kind: string }).kind)
    expect(kinds).toContain("turn_start")
    expect(kinds).toContain("assistant_text")
    expect(kinds).toContain("tool_call")
    expect(kinds).toContain("tool_result")
    expect(kinds).toContain("session_end")
    expect(kinds).toContain("llm_usage")

    const seqs = lines.map((l) => (l as { seq: number }).seq)
    for (let i = 1; i < seqs.length; i++) {
      expect((seqs[i] as number) > (seqs[i - 1] as number)).toBe(true)
    }

    const usageLine = lines.find((l) => (l as { kind: string }).kind === "llm_usage") as {
      ctx: RunContext
      data: { model: string; inputTokens: number; outputTokens: number }
    }
    expect(usageLine.ctx.runId).toBe(runId)
    expect(usageLine.data.model).toBe("fake-1")
    expect(usageLine.data.inputTokens).toBe(100)
    expect(usageLine.data.outputTokens).toBe(20)

    // Per-turn correlation: every line carries the run id; turns advance.
    const turnNumbers = lines
      .filter((l) => (l as { kind: string }).kind === "turn_start")
      .map((l) => (l as { data: { turn: number } }).data.turn)
    expect(turnNumbers).toEqual([1, 2])
  })
})
