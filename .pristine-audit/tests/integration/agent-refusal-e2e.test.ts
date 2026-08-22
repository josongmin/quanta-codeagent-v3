/**
 * Refusal stop_reason end-to-end (ADR-0076 Gap-1 SOTA++).
 *
 * Drives the REAL `runAgent` with a scripted fake LLMPort that emits
 * `stop_reason="refusal"`. Asserts the integrated contract:
 *
 *   - `AgentOutcome.reason === "refusal"`           (typed, not `"error"`)
 *   - `AgentOutcome.refusal.rationale === <text>`    (visible-text only)
 *   - `AgentOutcome.stopCategory.kind === "refusal"`  + reasonCode `model.refusal`
 *   - `outcome.messages` ends with the refusing assistant message
 *   - `outcome.turns === 1` (the refusing turn is productive — model talked)
 *   - `stream` emits a `done {reason:"refusal", turns:1}` event
 *
 * Hell cases driven through the FULL loop (not just `decideOnAssembled` units):
 *   H1 — refusal with empty content        → rationale=""
 *   H2 — refusal with multi text blocks    → joined with "\n\n"
 *   H3 — refusal AFTER tool_use blocks     → rationale STILL extracted, tools
 *                                             tombstoned (no dispatch)
 *   H4 — refusal AFTER an earlier completed turn (tool round) → still routes
 *                                             to refusal at the second turn
 *   H5 — refusal does NOT consume retry budgets; one LLM call, no thrash
 *   H6 — non-refusal outcomes still byte-identical (regression fence)
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

type Step = { kind: "throw"; error: unknown } | { kind: "events"; events: StreamEvent[] }

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

const refusalEvents = (...texts: string[]): StreamEvent[] => [
  ...texts.flatMap((t): StreamEvent[] => [{ type: "text_delta", delta: t }]),
  { type: "message_stop", stop_reason: "refusal" },
]

const completedEvents = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

const ev = (events: StreamEvent[]): Step => ({ kind: "events", events })

const cfg = (
  llm: LLMPort,
  stream: RecordingStream,
  over: Partial<AgentConfig> = {},
): AgentConfig => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream,
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
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

describe("refusal e2e — integrated runAgent", () => {
  test("baseline: single-text refusal → outcome.reason='refusal' + refusal.rationale + stopCategory", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([ev(refusalEvents("I cannot help with that — policy X."))])
    const out = await withTimeout(runAgent(cfg(llm, stream, { maxTurns: 3 })), 10_000, "baseline")

    expect(out.reason).toBe("refusal")
    expect(out.refusal).toBeDefined()
    expect(out.refusal?.rationale).toBe("I cannot help with that — policy X.")
    expect(out.stopCategory?.kind).toBe("refusal")
    expect(out.stopCategory?.reasonCode).toBe("model.refusal")

    // The refusing assistant turn IS productive (model spoke); maxTurns
    // accounting mirrors completed (turn, not turn-1).
    expect(out.turns).toBe(1)
    expect(llm.calls).toBe(1)

    // Final assistant message landed in the transcript.
    const last = out.messages.at(-1)
    expect(last?.role).toBe("assistant")
    expect(last?.content.some((b) => b.type === "text" && b.text.includes("policy X"))).toBe(true)

    // Stream emitted a typed done event.
    const done = stream.events.find((e) => e.type === "done")
    expect(done).toBeDefined()
    if (done?.type === "done") {
      expect(done.reason).toBe("refusal")
      expect(done.turns).toBe(1)
    }
  })

  test("H1: refusal with no visible text → rationale='' (omitted ≠ undefined check)", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([ev([{ type: "message_stop", stop_reason: "refusal" }])])
    const out = await withTimeout(runAgent(cfg(llm, stream)), 10_000, "empty-refusal")
    expect(out.reason).toBe("refusal")
    expect(out.refusal).toBeDefined()
    expect(out.refusal?.rationale).toBe("")
  })

  test("H2: refusal with multi text_delta → joined verbatim (deltas concat into one text block)", async () => {
    const stream = new RecordingStream()
    // text_delta blocks concatenate within ONE content block (the assembler
    // builds one `text` block from sequential text_deltas). Rationale is the
    // joined text, NOT the array of deltas.
    const llm = new ScriptedLLM([ev(refusalEvents("I cannot do this. ", "It violates policy."))])
    const out = await withTimeout(runAgent(cfg(llm, stream)), 10_000, "multi-delta")
    expect(out.reason).toBe("refusal")
    expect(out.refusal?.rationale).toBe("I cannot do this. It violates policy.")
  })

  test("H3: refusal AFTER tool_use → rationale STILL extracted, tool_use ignored (tombstoned)", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev([
        { type: "text_delta", delta: "Reconsidered — refusing." },
        { type: "tool_use_start", id: "call_zombie", name: "read" },
        { type: "tool_use_end", id: "call_zombie", input: { path: "/x" } },
        { type: "message_stop", stop_reason: "refusal" },
      ]),
    ])
    const out = await withTimeout(runAgent(cfg(llm, stream)), 10_000, "tool-then-refuse")
    expect(out.reason).toBe("refusal")
    expect(out.refusal?.rationale).toBe("Reconsidered — refusing.")
    expect(llm.calls).toBe(1) // no continuation — refusal is terminal
  })

  test("H4: tool round THEN refusal on next turn → still routes to refusal", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      // Turn 1: a tool call that completes
      ev([
        { type: "tool_use_start", id: "t1", name: "read" },
        {
          type: "tool_use_end",
          id: "t1",
          input: { path: "/tmp/missing-file" }, // tool result doesn't matter; loop continues
        },
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
      // Turn 2: model refuses
      ev(refusalEvents("After seeing the file I must decline.")),
    ])
    const out = await withTimeout(
      runAgent(cfg(llm, stream, { maxTurns: 3 })),
      10_000,
      "two-turn-refuse",
    )
    expect(out.reason).toBe("refusal")
    expect(out.refusal?.rationale).toBe("After seeing the file I must decline.")
    expect(out.turns).toBe(2)
  })

  test("H5: refusal does NOT consume retry budgets — one LLM call, no thrash", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([ev(refusalEvents("policy denial"))])
    const out = await withTimeout(runAgent(cfg(llm, stream, { maxTurns: 5 })), 10_000, "no-retry")
    expect(out.reason).toBe("refusal")
    // CRITICAL: terminal — no nudge / no continuation / no backoff.
    expect(llm.calls).toBe(1)
    expect(out.turns).toBe(1)
  })

  test("H6 byte-identical fence: non-refusal end_turn → outcome.refusal omitted", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([ev(completedEvents("done normally"))])
    const out = await withTimeout(runAgent(cfg(llm, stream)), 10_000, "no-refusal")
    expect(out.reason).toBe("completed")
    // exactOptionalPropertyTypes: the field must be ABSENT, not `undefined`.
    expect("refusal" in out).toBe(false)
    expect(out.stopCategory?.kind).toBe("completed")
  })
})
