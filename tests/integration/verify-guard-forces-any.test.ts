import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"

/**
 * ADR-0079 integration — verify-guard ARM ⇒ next outbound LLM request carries
 * `tool_choice: {kind:"any"}`. This proves the loop wiring (NOT just the pure
 * `resolveToolChoice` policy): when the verify-guard blocks a finish attempt
 * after an unverified mutating tool, the very next LLM stream call MUST be
 * shaped with `StreamInput.toolChoice.kind === "any"` so the adapter forces
 * the model to call a tool.
 *
 * Mechanism asserted:
 *   1. turn 1 — model emits `edit` (mutating, unverified).
 *   2. turn 2 — model emits pure-text "done" (finish-intent).
 *   3. verify-guard fires: injects forcing meta + ARMs `verifyGuardViolated`.
 *   4. SAME-TURN forced re-entry — the new LLM call MUST have
 *      `tool_choice.kind === "any"` on its `StreamInput`.
 *   5. model now emits a `test_runner` (the gate worked — model satisfied "any").
 *   6. closeout text → run completes.
 *
 * Recording is via a fake LLMPort capturing every `StreamInput` so we can
 * read the EXACT inputs the loop sent.
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

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
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
  new ToolRegistry([
    stubTool("read", true),
    stubTool("edit", false),
    stubTool("test_runner", false),
    stubTool("bash", false),
  ])

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: stubRegistry(),
  stream: new RecordingStream(),
  permission: { mode: "bypass" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "fix the bug" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 8,
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

describe("verify-guard arms tool_choice:'any' on next LLM call (ADR-0079)", () => {
  test("after edit+unverified-finish, the FORCED re-entry's StreamInput has toolChoice.kind === 'any'", async () => {
    // turn 1: edit (mutating). turn 2: pure text "done" → guard fires →
    // forces SAME-TURN re-entry with ARM. turn 3 (forced re-entry): model
    // is given tool_choice:"any" — emits test_runner. turn 4: text → done.
    const llm = new RecordingLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
      ev(text("All done.")),
      ev(toolUse("t1", "test_runner", {})),
      ev(text("Verified.")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, verifyGuard: { maxTrips: 2 }, maxTurns: 6 })),
      15_000,
      "verify-guard-forces-any",
    )

    expect(out.reason).toBe("completed")
    // 4 LLM calls landed (edit + finish-attempt + forced + closeout).
    expect(llm.calls).toBe(4)

    // Call 1 (edit dispatch): no flag is armed yet ⇒ auto/undefined on wire.
    const call1 = llm.inputs[0]
    expect(call1?.toolChoice?.kind ?? "auto").toBe("auto")

    // Call 2 (model's finish-intent text turn): again no ARM yet — verify
    // guard fires AFTER this call's assembled message.
    const call2 = llm.inputs[1]
    expect(call2?.toolChoice?.kind ?? "auto").toBe("auto")

    // Call 3 (FORCED re-entry): this is the assertion that pins the wiring.
    // The verify-guard armed `verifyGuardViolated`, `consumeTurnSignals` at
    // the top of the next runTurn iteration read+cleared it, resolved to
    // {kind:"any"}, and `streamConsume` threaded it onto StreamInput.
    const call3 = llm.inputs[2]
    expect(call3?.toolChoice).toEqual({ kind: "any" })

    // Call 4 (closeout text turn): flag was cleared on read ⇒ back to auto.
    const call4 = llm.inputs[3]
    expect(call4?.toolChoice?.kind ?? "auto").toBe("auto")
  })

  test("with NO verifyGuard config: every StreamInput.toolChoice is auto/undefined (byte-identical)", async () => {
    // Same edit-then-finish script but with the guard absent. No flag ever
    // gets armed ⇒ every consume returns {} ⇒ resolveToolChoice → auto ⇒
    // adapter omits the wire field. We assert toolChoice.kind === "auto"
    // (the loop always threads through; the BYTE-identical part is the
    // adapter omit, asserted in the unit suite below).
    const llm = new RecordingLLM([
      ev(toolUse("e1", "edit", { path: "/x.ts", patch: "fix" })),
      ev(text("All done.")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, maxTurns: 6 })),
      15_000,
      "verify-guard-off-byte-identical",
    )
    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(2)
    for (const input of llm.inputs) {
      // Either explicit auto (loop always threads) or the adapter would
      // see undefined and omit. Both shapes are byte-identical post-adapter.
      expect(input.toolChoice?.kind ?? "auto").toBe("auto")
    }
  })
})
