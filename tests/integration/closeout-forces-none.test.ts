import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"

/**
 * ADR-0079 integration — closeout-guard ARM ⇒ next outbound LLM request
 * carries `tool_choice: {kind:"none"}`. The closeout-guard, when enabled,
 * injects a single-shot closeout reminder at finish-intent; the next LLM
 * stream MUST be a terminal text turn (the model is FORBIDDEN from emitting
 * any tool_use to keep delaying closeout).
 *
 * Mechanism asserted:
 *   1. turn 1 — model emits pure text (finish-intent, no mutating tool).
 *   2. closeout-guard fires (enabled, never tripped yet): injects reminder +
 *      ARMs `closeoutAttempted`.
 *   3. SAME-TURN forced re-entry — the new LLM call MUST have
 *      `tool_choice.kind === "none"` on its `StreamInput`.
 *   4. model emits closeout text → run completes.
 *
 * Compare with verify-guard-forces-any.test.ts: same harness, different
 * trigger + different forced choice. The two flags can in principle co-arm
 * (a session that mutated AND attempted closeout) — the precedence ladder
 * (verify > closeout) is asserted in the unit suite.
 */

type Step = { kind: "events"; events: StreamEvent[] }

class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "scripted-test-model"
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

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })

const stubTool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: `stub ${name}`,
  inputSchema: z.any(),
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  async *execute() {
    yield { type: "result", result: { ok: true, output: `${name} ok` } }
  },
})

const stubRegistry = (): ToolRegistry =>
  new ToolRegistry([stubTool("read", true), stubTool("edit", false)])

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: stubRegistry(),
  stream: new RecordingStream(),
  permission: { mode: "bypass" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "analyze" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 6,
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

describe("closeout-guard arms tool_choice:'none' on next LLM call (ADR-0079)", () => {
  test("after first finish-intent, the FORCED re-entry's StreamInput has toolChoice.kind === 'none'", async () => {
    // turn 1: pure text finish-intent (analysis-only session, no tool ran).
    // closeout-guard fires (single-shot): injects reminder + ARMs.
    // turn 2 (forced re-entry): MUST see tool_choice.kind === "none".
    // Model emits closeout text → completed.
    const llm = new RecordingLLM([ev(text("My analysis is done.")), ev(text("Closeout text."))])
    const out = await withTimeout(
      runAgent(cfg({ llm, closeoutGuard: { enabled: true }, maxTurns: 4 })),
      15_000,
      "closeout-forces-none",
    )

    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(2)

    // Call 1: nothing armed yet ⇒ auto.
    const call1 = llm.inputs[0]
    expect(call1?.toolChoice?.kind ?? "auto").toBe("auto")

    // Call 2 (forced closeout re-entry): the precise wiring assertion. The
    // closeout-guard armed `closeoutAttempted`, consumeTurnSignals read it,
    // resolveToolChoice → {kind:"none"}, streamConsume threaded it onto
    // StreamInput. The adapter will map "none" to Anthropic
    // `tool_choice:{type:"none"}` / OpenAI `tool_choice:"none"` so the model
    // is FORBIDDEN from emitting any tool_use.
    const call2 = llm.inputs[1]
    expect(call2?.toolChoice).toEqual({ kind: "none" })
  })

  test("closeoutGuard disabled (default-OFF) ⇒ every StreamInput.toolChoice is auto", async () => {
    // Without the guard the closeoutAttempted flag is never armed; the loop
    // threads {kind:"auto"} for every call ⇒ byte-identical wire payload.
    const llm = new RecordingLLM([ev(text("Done."))])
    const out = await withTimeout(
      runAgent(cfg({ llm, maxTurns: 4 })),
      15_000,
      "closeout-guard-off-byte-identical",
    )
    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(1)
    for (const input of llm.inputs) {
      expect(input.toolChoice?.kind ?? "auto").toBe("auto")
    }
  })

  test("closeout-guard is single-shot — only the FIRST finish-intent arms the gate", async () => {
    // The closeout-guard is single-shot (`state.trips >= 1` ⇒ no block). A
    // model that emits text → forced "none" → text-again should see "none"
    // ONLY on the first forced re-entry; if the loop allowed a second nudge,
    // it would re-arm and we'd see "none" again. The single-shot policy plus
    // the 1-turn-TTL consume together pin behavior: exactly ONE call has
    // toolChoice.kind === "none", everything before and after is auto.
    const llm = new RecordingLLM([ev(text("first")), ev(text("second")), ev(text("third"))])
    const out = await withTimeout(
      runAgent(cfg({ llm, closeoutGuard: { enabled: true }, maxTurns: 4 })),
      15_000,
      "closeout-single-shot",
    )
    expect(out.reason).toBe("completed")
    // single-shot: edit-less session, no mutating tool, but the closeout
    // armed once at first finish. The 1-turn-TTL clears it on the next
    // consume so the third call (if any) is back to auto.
    const armed = llm.inputs.filter((i) => i.toolChoice?.kind === "none")
    expect(armed).toHaveLength(1)
  })
})
