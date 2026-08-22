/**
 * ALBB-03 — `content_filtered` default-path terminal-refusal e2e.
 *
 * The DEFAULT production posture: `refusalFallback` OFF and `stopReasonPolicy`
 * unset. On this path an OpenAI `content_filter` incomplete-reason maps (on the
 * wire, `openai-responses-wire.ts:743-748`) to the canonical stop-reason
 * `content_filtered`. This suite drives the REAL `runAgent` with a scripted LLM
 * that emits exactly that stop event (the wire's guaranteed output shape) and
 * pins the fail-closed contract that ticket ALBB-03 requires:
 *
 *   E1 — a text-only `content_filtered` turn does NOT seal `{ kind: "completed" }`;
 *        it terminates as a `refusal` (Claude Code / Codex parity — a provider
 *        content-filter/safety stop is a terminal refusal executing no tools).
 *   E2 — a `content_filtered` stop that queued a BARRIER-DEFERRED MUTATING tool
 *        mid-stream does NOT drain it: the mutating tool's `execute` NEVER runs.
 *        (This is the live, non-pinned defect — the deferred MUTATING drain.)
 *   E3 — 4-combo config matrix (policy {unset, set-continue} × fallback {off,on})
 *        asserts NO combo silently seals `completed` on a content-filter stop —
 *        a future default-ON policy cannot silently regress this.
 *
 * Reverting EITHER literal (`decideRefusal` seam swap OR the streaming-dispatch
 * `stopReason !== "refusal"` gate) re-reds E1/E2 respectively.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { LLMError } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, type Tool, type ToolEvent, ToolRegistry } from "@/tool"

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  private readonly steps: StreamEvent[][]
  constructor(steps: StreamEvent[][]) {
    this.steps = steps
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (!step) throw new LLMError("script exhausted")
    for (const ev of step) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** A spy MUTATING, concurrency-UNSAFE tool. `runAgent` defers it behind the
 *  head-of-line barrier (isConcurrencySafe:false ⇒ Phase-3 deferred slot), so
 *  a refusal-class short-circuit must skip its dispatch and its `execute` must
 *  NEVER be observed to run. `ran` flips true iff the tool actually executed. */
const makeSpyMutatingTool = (): { tool: Tool; ran: () => boolean } => {
  let executed = false
  const tool: Tool = {
    name: "spy_mutate",
    description: "test-only mutating tool that records whether it ran",
    inputSchema: z.object({ x: z.string().optional() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    // eslint-disable-next-line require-yield
    async *execute(): AsyncIterable<ToolEvent> {
      executed = true
      yield { type: "result", result: { ok: true, output: "MUTATED" } }
    },
  }
  return { tool, ran: () => executed }
}

/** The exact wire output for an OpenAI `content_filter` incomplete-reason:
 *  a mid-stream tool_use that engages the barrier, refusal text, then the
 *  `content_filtered` stop. */
const contentFilteredWithDeferredMutation = (): StreamEvent[] => [
  { type: "tool_use_start", id: "cf1", name: "spy_mutate" },
  { type: "tool_use_end", id: "cf1", input: { x: "danger" } },
  { type: "text_delta", delta: "Blocked by content filter." },
  { type: "message_stop", stop_reason: "content_filtered" },
]

const contentFilteredTextOnly = (): StreamEvent[] => [
  { type: "text_delta", delta: "Blocked by content filter." },
  { type: "message_stop", stop_reason: "content_filtered" },
]

const cfg = (
  llm: LLMPort,
  stream: RecordingStream,
  registry: ToolRegistry,
  over: Partial<AgentConfig> = {},
): AgentConfig => ({
  llm,
  registry,
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

describe("ALBB-03 content_filtered default-path terminal-refusal e2e", () => {
  test("E1: text-only content_filtered does NOT seal completed — terminates as refusal", async () => {
    const stream = new RecordingStream()
    const registry = new ToolRegistry(defaultTools)
    const llm = new ScriptedLLM([contentFilteredTextOnly()])
    const out = await withTimeout(
      // DEFAULT posture: refusalFallback omitted (OFF), no stopReasonPolicy.
      runAgent(cfg(llm, stream, registry, { maxTurns: 3 })),
      10_000,
      "E1",
    )
    // The core acceptance: NOT a silent completed seal.
    expect(out.reason).not.toBe("completed")
    expect(out.reason).toBe("refusal")
    expect(llm.calls).toBe(1) // terminal — no continuation nudge/thrash
  })

  test("E2: content_filtered with a barrier-deferred MUTATING slot NEVER drains it", async () => {
    const stream = new RecordingStream()
    const { tool, ran } = makeSpyMutatingTool()
    const registry = new ToolRegistry([...defaultTools, tool])
    const llm = new ScriptedLLM([contentFilteredWithDeferredMutation()])
    const out = await withTimeout(
      runAgent(cfg(llm, stream, registry, { maxTurns: 3 })),
      10_000,
      "E2",
    )
    // The live defect this ticket closes: the deferred MUTATING tool must NOT
    // have executed. Pre-fix, streaming-dispatch drained it because the gate
    // matched the literal `!== "refusal"`.
    expect(ran()).toBe(false)
    // And the turn is terminal-refusal, not a completed seal.
    expect(out.reason).not.toBe("completed")
    expect(out.reason).toBe("refusal")
    expect(llm.calls).toBe(1)
  })

  test("E3: 4-combo matrix (policy {unset,set-continue} × fallback {off,on}) — no combo seals completed", async () => {
    // A content-filter stop must stay terminal across the config surface so a
    // future default-ON policy cannot silently regress the fail-closed posture.
    const combos: Array<{ label: string; over: Partial<AgentConfig> }> = [
      { label: "policy=unset, fallback=off", over: {} },
      { label: "policy=unset, fallback=on", over: { refusalFallback: { enabled: true } } },
      {
        label: "policy=set-continue, fallback=off",
        over: { stopReasonPolicy: { handle: () => ({ kind: "continue" }) } },
      },
      {
        label: "policy=set-continue, fallback=on",
        over: {
          stopReasonPolicy: { handle: () => ({ kind: "continue" }) },
          refusalFallback: { enabled: true },
        },
      },
    ]
    for (const { label, over } of combos) {
      const stream = new RecordingStream()
      const registry = new ToolRegistry(defaultTools)
      // fallback=on would re-prompt once then (on a re-refusal) terminate; give
      // it a second content_filtered turn so the script never exhausts.
      const llm = new ScriptedLLM([contentFilteredTextOnly(), contentFilteredTextOnly()])
      const out = await withTimeout(
        runAgent(cfg(llm, stream, registry, { maxTurns: 3, ...over })),
        10_000,
        `E3 ${label}`,
      )
      expect(out.reason, `combo [${label}] must not seal completed`).not.toBe("completed")
    }
  })
})
