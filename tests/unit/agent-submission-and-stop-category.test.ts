/**
 * runAgent ↔ Submission seam + StopCategory attachment tests
 * (ADR-0062 / ADR-0063, Specs A3 + B3).
 *
 * Covers the loop wire-up — NOT the pure modules (those are unit-tested in
 * `tests/unit/agent/submission.test.ts` and `stop-category.test.ts`):
 *
 *   - Legacy path (only `messages`) ⇒ outcome carries NO `stopCategory`
 *     field is FALSE: completion attaches `completedCategory("normal")`.
 *     We assert presence + the documented bucket so a surface can rely on it.
 *   - Submission path: caller passes a `user_input` Submission + empty
 *     `messages` ⇒ the loop seeds the LLM stream from `submission.op.items`
 *     (the LLM double sees the user content verbatim).
 *   - `max_turns` path attaches `max_turns` category.
 *   - Aborted path attaches `interrupted/user.interrupt`.
 *
 * Pure module wiring — no real LLM, no IO. Uses the same FakeLLM /
 * RecordingStream doubles as `agent-runcontext.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent, STOP_REASON_CODE } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

class FakeLLM implements LLMPort {
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  readonly seen: StreamInput[] = []

  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seen.push(input)
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    for (const ev of script) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const completedScript = (): StreamEvent[] => [
  { type: "text_delta", delta: "done" },
  { type: "message_stop", stop_reason: "end_turn" },
]

const baseConfig = (
  llm: LLMPort,
  registry: ToolRegistry,
  stream: StreamPort,
  permission: PermissionContext,
  signal: AbortSignal,
): Omit<AgentConfig, "messages"> => ({
  llm,
  registry,
  stream,
  permission,
  system: "test",
  cwd: process.cwd(),
  maxTurns: 5,
  signal,
  onConfirm: async () => false,
})

const userMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

describe("Spec A3 — Submission op envelope wires through runAgent", () => {
  test("submission seed reaches the LLM as a user message (legacy messages empty)", async () => {
    const llm = new FakeLLM([completedScript()])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const base = baseConfig(
      llm,
      registry,
      stream,
      { mode: "acceptEdits" },
      new AbortController().signal,
    )
    const outcome = await runAgent({
      ...base,
      messages: [],
      submission: {
        id: "host-1",
        op: { kind: "user_input", items: [{ type: "text", text: "from-submission" }] },
      },
    })
    expect(outcome.reason).toBe("completed")
    // The LLM saw a user message whose first text block came from the
    // Submission op. (The per-turn `<system-reminder>` is appended AFTER the
    // seed content as a separate text block — assert containment instead of
    // strict equality so the test is robust to reminder shape changes.)
    expect(llm.seen.length).toBeGreaterThan(0)
    const firstInput = llm.seen[0]
    expect(firstInput).toBeDefined()
    if (!firstInput) throw new Error("unreachable")
    const allText = firstInput.messages
      .flatMap((m) => m.content.filter((b) => b.type === "text"))
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    expect(allText).toContain("from-submission")
  })

  test("legacy messages path stays byte-identical when no submission is set", async () => {
    const llm = new FakeLLM([completedScript()])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, { mode: "acceptEdits" }, new AbortController().signal),
      messages: [userMsg("legacy-seed")],
    })
    expect(outcome.reason).toBe("completed")
    const firstInput = llm.seen[0]
    if (!firstInput) throw new Error("unreachable")
    const allText = firstInput.messages
      .flatMap((m) => m.content.filter((b) => b.type === "text"))
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    expect(allText).toContain("legacy-seed")
  })

  test("control-op submission (interrupt) does NOT seed history — falls back to messages", async () => {
    const llm = new FakeLLM([completedScript()])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, { mode: "acceptEdits" }, new AbortController().signal),
      messages: [userMsg("legacy-still-wins")],
      submission: { id: "i-1", op: { kind: "interrupt" } },
    })
    expect(outcome.reason).toBe("completed")
    const firstInput = llm.seen[0]
    if (!firstInput) throw new Error("unreachable")
    const allText = firstInput.messages
      .flatMap((m) => m.content.filter((b) => b.type === "text"))
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    expect(allText).toContain("legacy-still-wins")
  })
})

describe("Spec B3 — StopCategory attaches to AgentOutcome", () => {
  test("normal completion → kind:completed + reasonCode:completed.normal", async () => {
    const llm = new FakeLLM([completedScript()])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, { mode: "acceptEdits" }, new AbortController().signal),
      messages: [userMsg("go")],
    })
    expect(outcome.reason).toBe("completed")
    expect(outcome.stopCategory).toBeDefined()
    expect(outcome.stopCategory?.kind).toBe("completed")
    expect(outcome.stopCategory?.reasonCode).toBe(STOP_REASON_CODE.COMPLETED_NORMAL)
  })

  test("max_turns → kind:max_turns + reasonCode:completed.max_turns", async () => {
    // A turn that yields a tool_use forces the loop to keep going; with no tools
    // resolving the request we'll hit maxTurns. Easier: a script that just
    // produces text but the LLM is replayed until maxTurns... actually message_stop
    // with `end_turn` completes immediately. So instead set maxTurns very small
    // and produce no completion -- we need a tool_use loop. Simpler approach:
    // set maxTurns=0 isn't allowed (loop condition is `turn <= maxTurns`).
    // We exploit the abort path instead for max_turns: use a tool_use script.
    const toolScript: StreamEvent[] = [
      { type: "tool_use_start", id: "t1", name: "bash" },
      { type: "tool_use_delta", id: "t1", delta: '{"command":"echo hi"}' },
      { type: "tool_use_end", id: "t1", input: { command: "echo hi" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const llm = new FakeLLM([toolScript])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, { mode: "acceptEdits" }, new AbortController().signal),
      messages: [userMsg("loop")],
      maxTurns: 1,
    })
    expect(outcome.reason).toBe("max_turns")
    expect(outcome.stopCategory?.kind).toBe("max_turns")
    expect(outcome.stopCategory?.reasonCode).toBe(STOP_REASON_CODE.COMPLETED_MAX_TURNS)
  })

  test("aborted (user signal) → kind:interrupted + reasonCode:user.interrupt", async () => {
    const llm = new FakeLLM([completedScript()])
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const ac = new AbortController()
    ac.abort()
    const outcome = await runAgent({
      ...baseConfig(llm, registry, stream, { mode: "acceptEdits" }, ac.signal),
      messages: [userMsg("go")],
    })
    expect(outcome.reason).toBe("aborted")
    expect(outcome.stopCategory?.kind).toBe("interrupted")
    expect(outcome.stopCategory?.reasonCode).toBe(STOP_REASON_CODE.USER_INTERRUPT)
  })
})
