import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
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

const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** One assistant turn issuing multiple tool_use blocks in order. */
const multiToolScript = (calls: { id: string; name: string; input: unknown }[]): StreamEvent[] => [
  ...calls.flatMap((c): StreamEvent[] => [
    { type: "tool_use_start", id: c.id, name: c.name },
    { type: "tool_use_end", id: c.id, input: c.input },
  ]),
  { type: "message_stop", stop_reason: "tool_use" },
]

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

const baseConfig = (
  llm: LLMPort,
  registry: ToolRegistry,
  stream: StreamPort,
  cwd: string,
  permission: PermissionContext,
  maxTurns: number,
): AgentConfig => ({
  llm,
  registry,
  stream,
  permission,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd,
  maxTurns,
  signal: new AbortController().signal,
  onConfirm: async () => false,
})

describe("runAgent integration", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-loop-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("(a) happy path: write tool then text → completed, file on disk, events ordered", async () => {
    const file = join(dir, "out.txt")
    const llm = new FakeLLM([
      toolUseScript("c1", "write", { path: file, content: "hello disk" }),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")
    expect(outcome.turns).toBe(2)
    expect(readFileSync(file, "utf8")).toBe("hello disk")

    const types = stream.events.map((e) => e.type)
    const callIdx = types.indexOf("tool_call")
    const resultIdx = types.indexOf("tool_result")
    const doneIdx = types.indexOf("done")
    expect(callIdx).toBeGreaterThanOrEqual(0)
    expect(callIdx).toBeLessThan(resultIdx)
    expect(resultIdx).toBeLessThan(doneIdx)

    const resultEv = stream.events[resultIdx]
    expect(resultEv?.type).toBe("tool_result")
    if (resultEv?.type === "tool_result") {
      expect(resultEv.ok).toBe(true)
      expect(resultEv.name).toBe("write")
    }
    const doneEv = stream.events[doneIdx]
    if (doneEv?.type === "done") expect(doneEv.reason).toBe("completed")
  })

  test("(b) tool error recovery: failed read then text → completed, error block in transcript", async () => {
    const missing = join(dir, "does-not-exist.txt")
    const llm = new FakeLLM([
      toolUseScript("c1", "read", { path: missing }),
      textScript("recovered"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")

    const errorBlocks = outcome.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result" && b.is_error === true),
    )
    expect(errorBlocks).toHaveLength(1)

    const resultEv = stream.events.find((e) => e.type === "tool_result")
    expect(resultEv?.type).toBe("tool_result")
    if (resultEv?.type === "tool_result") expect(resultEv.ok).toBe(false)
  })

  test("(c) max_turns: always tool_use → stops at maxTurns", async () => {
    const file = join(dir, "loop.txt")
    const llm = new FakeLLM([toolUseScript("c1", "write", { path: file, content: "x" })])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 3),
    )

    expect(outcome.reason).toBe("max_turns")
    expect(outcome.turns).toBe(3)
    expect(llm.calls).toBe(3)
  })

  test("(d) permission deny: hard-denied bash, loop continues, then completed", async () => {
    const llm = new FakeLLM([
      toolUseScript("c1", "bash", { command: "rm -rf /" }),
      textScript("ok then"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(baseConfig(llm, registry, stream, dir, { mode: "bypass" }, 10))

    expect(outcome.reason).toBe("completed")

    const denied = outcome.messages.flatMap((m) =>
      m.content.filter(
        (b) =>
          b.type === "tool_result" &&
          b.is_error === true &&
          b.content.includes("Permission denied"),
      ),
    )
    expect(denied).toHaveLength(1)

    const resultEv = stream.events.find((e) => e.type === "tool_result")
    if (resultEv?.type === "tool_result") expect(resultEv.ok).toBe(false)
  })

  test("(e) two concurrency-safe reads in one turn → both results, order preserved", async () => {
    const f1 = join(dir, "one.txt")
    const f2 = join(dir, "two.txt")
    writeFileSync(f1, "AAA")
    writeFileSync(f2, "BBB")
    const llm = new FakeLLM([
      multiToolScript([
        { id: "r1", name: "read", input: { path: f1 } },
        { id: "r2", name: "read", input: { path: f2 } },
      ]),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")

    const resultMsg = outcome.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )
    const ids = resultMsg?.content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))
    expect(ids).toEqual(["r1", "r2"])

    const r1 = resultMsg?.content.find((b) => b.type === "tool_result" && b.tool_use_id === "r1")
    const r2 = resultMsg?.content.find((b) => b.type === "tool_result" && b.tool_use_id === "r2")
    expect(r1?.type === "tool_result" && r1.content).toContain("AAA")
    expect(r2?.type === "tool_result" && r2.content).toContain("BBB")

    // Both tool_call events emitted before either tool_result (batch ordering).
    const types = stream.events.map((e) => e.type)
    const lastCall = types.lastIndexOf("tool_call")
    const firstResult = types.indexOf("tool_result")
    expect(lastCall).toBeLessThan(firstResult)
  })

  test("(f) safe read then unsafe write in one turn → result order preserved", async () => {
    const src = join(dir, "src.txt")
    const out = join(dir, "out.txt")
    writeFileSync(src, "payload")
    const llm = new FakeLLM([
      multiToolScript([
        { id: "a", name: "read", input: { path: src } },
        { id: "b", name: "write", input: { path: out, content: "written" } },
      ]),
      textScript("done"),
    ])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent(
      baseConfig(llm, registry, stream, dir, { mode: "acceptEdits" }, 10),
    )

    expect(outcome.reason).toBe("completed")
    expect(readFileSync(out, "utf8")).toBe("written")

    const resultMsg = outcome.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )
    const ids = resultMsg?.content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))
    expect(ids).toEqual(["a", "b"])
  })
})
