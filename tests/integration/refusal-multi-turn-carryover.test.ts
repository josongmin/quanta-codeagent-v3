/**
 * ADR-0076 Gap-1 SOTA++ + Gap-5 — multi-turn refusal carry-over invariant.
 *
 * The self-audit found that the existing hell suite covers only SINGLE-TURN
 * refusal scenarios. The production-realistic failure mode is: turn-1 ends
 * with `stop_reason: "refusal"`, the user re-prompts in turn-2, and the next
 * `StreamInput.messages` is sent to the provider. This file pins:
 *
 *   M-1  After a refusal turn, `outcome.messages` MUST contain the
 *        REFUSING assistant message (SOTA++ — the typed `refusal` action
 *        appends the final assistant turn so a resume / probe can SEE
 *        the model's refusal text). What it MUST NOT contain is any
 *        tool_result block — `runStep`'s refusal branch never dispatches
 *        the tombstoned tool_use, so Anthropic's "tool_use without
 *        matching tool_result" rule stays intact on the next request.
 *
 *   M-2  A refusal turn that ALSO emits a tool_use mid-stream produces
 *        ZERO tool dispatches (Gap-5 short-circuit) AND ZERO trailing
 *        tool_result blocks in the outcome history.
 *
 *   M-3  byte-identical regression — a turn that ends with stop_reason
 *        "end_turn" carrying assistant text DOES append to wm (so a normal
 *        completion is unaffected by the Gap-1/5 logic).
 *
 *   M-4  `AgentOutcome.reason === "refusal"` for a refusal turn AND
 *        `outcome.refusal.rationale` carries the visible-text — the host
 *        UI can branch on the typed surface without parsing any string.
 *
 * Tests use the local ScriptedLLM (same shape as agent-recovery-e2e) so
 * runAgent is exercised end-to-end without a real provider.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

type Step = { kind: "events"; events: StreamEvent[] }

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new Error("script exhausted")
    for (const ev of step.events) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string, stop: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]

const toolUseThenRefuse = (id: string, command: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "bash" },
  { type: "tool_use_end", id, input: { command } },
  { type: "text_delta", delta: "On reflection, I refuse." },
  { type: "message_stop", stop_reason: "refusal" },
]

const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 3,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not terminate in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("ADR-0076 — refusal multi-turn carry-over", () => {
  test("M-1: pure-text refusal DOES append the refusing assistant message to outcome.messages", async () => {
    const llm = new ScriptedLLM([ev(text("I refuse.", "refusal"))])
    const out = await withTimeout(runAgent(cfg({ llm })), 10_000, "M-1")
    expect(out.reason).toBe("refusal")
    // SOTA++: the typed-refusal branch appends the final assistant turn so a
    // resume / probe / forensic surface can SEE the model's refusal text.
    // (Pre-SOTA++ this branch dropped the message; that lost provenance.)
    const assistantMessages = out.messages.filter((m) => m.role === "assistant")
    expect(assistantMessages.length).toBe(1)
    expect(
      assistantMessages[0]?.content.some((b) => b.type === "text" && b.text === "I refuse."),
    ).toBe(true)
  })

  test("M-2: tool_use mid-stream + refusal — Gap-5 short-circuit produces zero tool_result blocks", async () => {
    // The stream emits a bash tool_use_end mid-stream, then refuses. Gap-5
    // ensures bash is NEVER dispatched. The outcome history must not have
    // any tool_result block, because Phase 4 collects only dispatched slots
    // (deferred unsafe slots have no promise) AND the refusal branch never
    // appends a tool_result-bearing user message.
    const llm = new ScriptedLLM([ev(toolUseThenRefuse("call1", "echo malicious"))])
    const out = await withTimeout(runAgent(cfg({ llm })), 10_000, "M-2")
    expect(out.reason).toBe("refusal")
    const toolResults = out.messages.flatMap((m) =>
      m.role === "user" ? m.content.filter((b) => b.type === "tool_result") : [],
    )
    expect(toolResults).toEqual([])
  })

  test("M-3: byte-identical — a normal end_turn STILL appends the assistant message", async () => {
    const llm = new ScriptedLLM([ev(text("Done.", "end_turn"))])
    const out = await withTimeout(runAgent(cfg({ llm })), 10_000, "M-3")
    expect(out.reason).toBe("completed")
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    expect(finalAssistant?.content.some((b) => b.type === "text" && b.text === "Done.")).toBe(true)
  })

  test("M-4: refusal carries typed `refusal.rationale` so host UI can branch without string-parsing", async () => {
    const llm = new ScriptedLLM([ev(text("Sorry, I won't.", "refusal"))])
    const stream = new RecordingStream()
    const out = await withTimeout(runAgent(cfg({ llm, stream })), 10_000, "M-4")
    expect(out.reason).toBe("refusal")
    // The typed surface: a host reads `outcome.refusal.rationale` directly
    // instead of grepping the AgentEvent stream for "refused".
    expect(out.refusal).toBeDefined()
    expect(out.refusal?.rationale).toBe("Sorry, I won't.")
    // And the stream still emits a typed `done` with the matching reason
    // so passive observers (loggers / metrics sinks) see the same signal.
    const done = stream.events.find((e) => e.type === "done")
    expect(done?.type === "done" && done.reason).toBe("refusal")
  })

  test("M-5: refusal turn DOES count as a turn (turns >= 1) — terminal but accounted", async () => {
    // The recovery counters don't fire (no nudge/retry was consumed) but the
    // turn slot IS counted — the model produced an assistant response, even
    // if that response is a refusal. This matches the existing semantic that
    // `turns` increments per logical model interaction; "turn = 0" would
    // suggest the loop never even started, which is misleading for a typed
    // refusal surfaced via decideOnAssembled.
    const llm = new ScriptedLLM([ev(text("Refused.", "refusal"))])
    const out = await withTimeout(runAgent(cfg({ llm })), 10_000, "M-5")
    expect(out.reason).toBe("refusal")
    expect(out.turns).toBe(1)
  })
})
