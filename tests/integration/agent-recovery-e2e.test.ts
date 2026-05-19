import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/**
 * End-to-end coverage of the integrated recovery loop: drive the REAL
 * `runAgent` with a scripted fake LLMPort and assert on
 * `AgentOutcome.reason/.turns/.messages` plus the recorded LLM inputs.
 *
 * House fakes (same shape as agent-memory.test.ts's cfg(); redefined locally —
 * no private test helpers imported).
 */

type Step = { kind: "throw"; error: unknown } | { kind: "events"; events: StreamEvent[] }

/** Replays a script step-per-call. `throw` steps reject before yielding any
 *  event (so the loop's same-turn retry path is exercised). The last step is
 *  repeated if the loop calls more times than scripted (defensive). */
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
    if (!step) throw new LLMError("script exhausted")
    if (step.kind === "throw") throw step.error
    for (const ev of step.events) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string, stop = "end_turn"): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: stop },
]

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })
const thr = (error: unknown): Step => ({ kind: "throw", error })

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

/** Guard: every test must terminate well under this. The loop's bounded
 *  budgets guarantee termination; a hang here is a real loop bug. */
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

describe("recovery e2e — integrated runAgent", () => {
  test("1. transient stream error then success → completed, retried, turn not consumed", async () => {
    const llm = new ScriptedLLM([
      thr(new LLMError("503 service unavailable")),
      ev(text("recovered answer")),
    ])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 1 })), 15_000, "transient-retry")
    expect(out.reason).toBe("completed")
    // >=2 LLM calls proves it retried; maxTurns=1 yet it still completed →
    // the same-turn retry did NOT consume the single turn slot.
    expect(llm.calls).toBeGreaterThanOrEqual(2)
    expect(out.turns).toBe(1)
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    expect(
      finalAssistant?.content.some((b) => b.type === "text" && b.text === "recovered answer"),
    ).toBe(true)
  })

  test("2. transient error exceeding per-turn budget → error mentioning retries", async () => {
    // MAX_TURN_STREAM_RETRIES=3 → 4 consecutive throws exhausts the budget.
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      thr(new LLMError("503 a")),
      thr(new LLMError("503 b")),
      thr(new LLMError("503 c")),
      thr(new LLMError("503 d")),
      ev(text("never reached")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 3 })),
      20_000,
      "budget-exceeded",
    )
    expect(out.reason).toBe("error")
    expect(llm.calls).toBe(4)
    // The loop emits an error event whose message mentions retries.
    const errMsg = stream.events.find((e) => e.type === "error")
    expect(errMsg).toBeDefined()
    if (errMsg?.type === "error") expect(errMsg.message.toLowerCase()).toContain("retries")
  })

  test("3. PTL → reactive compaction then completed, turn not consumed", async () => {
    // Seed enough turns that reactiveCompact (keepRecentTurns=2) leaves a
    // summarizable prefix (needs >2 assistant turns).
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "first request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn one" }] },
      { role: "user", content: [{ type: "text", text: "second request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn two" }] },
      { role: "user", content: [{ type: "text", text: "third request" }] },
      { role: "assistant", content: [{ type: "text", text: "older turn three" }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
    ]
    const llm = new ScriptedLLM([
      thr(new LLMError("400 prompt is too long for this model")),
      ev(text("<summary>resume from here</summary>")), // reactiveCompact summary call
      ev(text("final answer after compaction")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, messages: history, maxTurns: 1 })),
      15_000,
      "ptl-compaction",
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1) // recovery did not consume the single turn slot
    // History was collapsed: a synthetic continuation-summary user message
    // now leads the transcript.
    const first = out.messages[0]
    expect(first?.role).toBe("user")
    const firstText = first?.content[0]?.type === "text" ? first.content[0].text : ""
    expect(firstText).toContain("continuation summary")
    expect(firstText).toContain("resume from here")
  })

  test("4. max_tokens partial then end_turn → completed, continue meta injected, partial kept", async () => {
    const llm = new ScriptedLLM([
      ev(text("partial work so far", "max_tokens")),
      ev(text("...and the rest, done")),
    ])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 1 })), 15_000, "max-tokens")
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    // Partial assistant text kept, and a "continue" meta user message injected.
    const partialKept = out.messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some((b) => b.type === "text" && b.text === "partial work so far"),
    )
    expect(partialKept).toBe(true)
    const continueMeta = out.messages.some(
      (m) =>
        m.role === "user" &&
        m.content.some((b) => b.type === "text" && b.text.toLowerCase().includes("continue")),
    )
    expect(continueMeta).toBe(true)
  })

  test("5. malformed tool_use: nudge+retry once, persists → treated as text, completes", async () => {
    // stop_reason "tool_use" but ZERO tool_use blocks, twice. MAX_MALFORMED
    // RETRIES=1 → first nudge, second occurrence treated as a normal turn.
    const llm = new ScriptedLLM([
      ev([
        { type: "text_delta", delta: "oops no tool" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
      ev([
        { type: "text_delta", delta: "still no tool" },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
    ])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 2 })), 15_000, "malformed-tool")
    expect(out.reason).toBe("completed")
    // Exactly 2 LLM calls (one nudge retry), no infinite loop.
    expect(llm.calls).toBe(2)
    expect(out.turns).toBe(1)
  })

  test("6. consecutive empty turns are capped → terminates completed", async () => {
    const empty: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const llm = new ScriptedLLM([ev(empty), ev(empty), ev(empty), ev(empty)])
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 3 })), 15_000, "empty-turns")
    expect(out.reason).toBe("completed")
    // MAX_CONSECUTIVE_EMPTIES=2 → 2 nudges then completed = 3 calls, no spin.
    expect(llm.calls).toBe(3)
    expect(out.turns).toBe(1)
  })

  test("7. genuine multi-turn tool loop (6 rounds) → completed, turns = real rounds only", async () => {
    // 6 tool rounds then a text answer. Interleave a transient error inside
    // one round to prove recovery retries are EXCLUDED from the turn count.
    const steps: Step[] = []
    for (let i = 0; i < 6; i++) {
      if (i === 3) steps.push(thr(new LLMError("timeout while reading"))) // same-turn retry
      steps.push(ev(toolUse(`t${i}`, "read", { path: "/tmp/probe" })))
    }
    steps.push(ev(text("all six rounds done")))
    const llm = new ScriptedLLM(steps)
    const out = await withTimeout(runAgent(cfg({ llm, maxTurns: 20 })), 20_000, "multi-turn-stable")
    expect(out.reason).toBe("completed")
    // 6 tool rounds advance the counter; the final text turn is round 7.
    // The injected transient error is a SAME-TURN retry and must NOT count.
    expect(out.turns).toBe(7)
    // 6 tool calls + 1 retry + 6 results-driven + final = 8 LLM calls total
    // (6 tool turns, +1 transient retry, +1 final text turn).
    expect(llm.calls).toBe(8)
    // Transcript has 6 tool_use assistant blocks and 6 tool_result user msgs.
    const toolUses = out.messages.filter(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"),
    ).length
    const toolResults = out.messages.filter(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    ).length
    expect(toolUses).toBe(6)
    expect(toolResults).toBe(6)
  })
})
