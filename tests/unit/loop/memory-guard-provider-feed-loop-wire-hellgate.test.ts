/**
 * jul-03 B3 AUDIT hellgate — the LIVE loop call-site that feeds the provider
 * rate-limit window into the BudgetMeter tap the memory write-guard reads.
 *
 * THE GAP THIS CLOSES (missed by the 3× self-audit): the implementer's wiring
 * test drives `buildToolingCore` and SEEDS the meter directly; the feed-seam unit
 * test pins the `feedProviderRateLimitToMeter` FUNCTION. Neither pins the CALL
 * SITE in `streamConsume`'s `onResponseHeaders` hook. MUTATION EVIDENCE: deleting
 * that call left every B3 test GREEN (and tsc clean, since the fn is still
 * exported) — the guard was fake at the loop boundary, wired-but-inert.
 *
 * This drives the REAL `runAgent` loop (mirrors delta-ratelimit-reachability's
 * `ScriptedLLM` adapter simulation) with a `budgetMeter` in the config and a
 * `x-codex-primary-used-percent` response header, and asserts the meter's
 * provider tap is populated (100 − used). Deleting the loop feed call ⇒ RED.
 *
 * SECOND INVARIANT PINNED (inertness coupling): the feed is only reachable when
 * the header hook is wired, which today requires QUANTA_RATELIMIT_NOTICE or
 * QUANTA_RATELIMIT_PROACTIVE. With NEITHER knob set, the hook is never wired ⇒
 * the provider tap stays `undefined` ⇒ the memory guard's provider arm silently
 * fails-open forever. This test documents that coupling (knob-OFF ⇒ tap
 * undefined) so a future change that decouples it will visibly flip this pin.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { BudgetMeter, runAgent } from "@/agent"
import type { AgentConfig } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import type { AgentEvent, StreamPort } from "@/stream"
import { defineTool, ToolRegistry } from "@/tool"

const noopSchema = z.object({ note: z.string().optional() })
const noopTool = defineTool<z.infer<typeof noopSchema>>({
  name: "noop",
  description: "no-op test tool",
  inputSchema: noopSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  // biome-ignore lint/correctness/useYield: single-result generator
  async *execute() {
    yield { type: "result", result: { ok: true, output: "ok" } } as const
  },
})

const withKnobs = async <T>(
  knobs: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> => {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(knobs)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetRuntimeConfig()
  try {
    return await fn()
  } finally {
    for (const [k] of Object.entries(knobs)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    __resetRuntimeConfig()
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Records the StreamInput it saw + fires the response-headers hook (SIMULATING
 *  the adapter's `.withResponse()` capture) so the LOOP wiring can be driven with
 *  no network — the same contract `delta-ratelimit-reachability` uses. */
class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "scripted"
  constructor(
    private readonly scripts: StreamEvent[][],
    private readonly headerScripts: Array<Record<string, string> | undefined> = [],
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const callIdx = this.calls
    this.calls += 1
    const headers = this.headerScripts[callIdx]
    if (input.onResponseHeaders !== undefined && headers !== undefined) {
      const lower: Record<string, string> = {}
      for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
      input.onResponseHeaders((name) => lower[name.toLowerCase()] ?? null)
    }
    const next = this.scripts.shift() ?? textScript("final")
    for (const ev of next) yield ev
  }
}

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry([noopTool]),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userText("go")],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

/** A first turn that requests the no-op tool so the loop opens a SECOND stream —
 *  giving call #0 the response header the feed reads. */
const toolThenFinal = (): StreamEvent[][] => [
  [
    { type: "tool_use_start", id: "t1", name: "noop" },
    { type: "tool_use_end", id: "t1", input: { note: "hi" } },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
  textScript("final answer"),
]

describe("B3 loop wire — onResponseHeaders feeds the BudgetMeter provider tap", () => {
  test("used-percent header on turn 1 ⇒ meter.providerRateLimitRemainingPercent === 100 − used (LIVE)", async () => {
    const meter = new BudgetMeter()
    const llm = new ScriptedLLM(toolThenFinal(), [
      { "x-codex-primary-used-percent": "88", "x-codex-primary-window-minutes": "300" },
      undefined,
    ])
    // NOTICE knob wires the header hook (the feed's only reachability path today).
    const out = await withKnobs({ QUANTA_RATELIMIT_NOTICE: "1" }, () =>
      runAgent(baseCfg({ llm, budgetMeter: meter })),
    )
    expect(out.reason).toBe("completed")
    // The loop wired the header hook (adapter-sim fired it).
    expect(llm.inputs[0]?.onResponseHeaders).toBeDefined()
    // ...and the feed pushed 100 − 88 = 12 into the provider tap the guard reads.
    expect(meter.providerRateLimitRemainingPercent()).toBe(12)
  })

  test("no used-percent header ⇒ tap stays undefined (byte-identical, arm fails-open)", async () => {
    const meter = new BudgetMeter()
    const llm = new ScriptedLLM(toolThenFinal(), [
      { "anthropic-ratelimit-tokens-remaining": "9000" }, // unrelated, no used-percent
      undefined,
    ])
    await withKnobs({ QUANTA_RATELIMIT_NOTICE: "1" }, () =>
      runAgent(baseCfg({ llm, budgetMeter: meter })),
    )
    expect(meter.providerRateLimitRemainingPercent()).toBeUndefined()
  })

  test("INERTNESS COUPLING (documented): no rate-limit knob ⇒ hook unwired ⇒ tap never fed", async () => {
    // With NEITHER QUANTA_RATELIMIT_NOTICE nor _PROACTIVE, the loop never wires
    // `onResponseHeaders`, so even a low-window header can NOT reach the meter —
    // the memory guard's provider arm is inert. Pinned so a future decoupling of
    // the provider-guard feed from the rate-limit-notice knob flips this visibly.
    const meter = new BudgetMeter()
    const llm = new ScriptedLLM(toolThenFinal(), [
      { "x-codex-primary-used-percent": "99", "x-codex-primary-window-minutes": "300" },
      undefined,
    ])
    await withKnobs(
      { QUANTA_RATELIMIT_NOTICE: undefined, QUANTA_RATELIMIT_PROACTIVE: undefined },
      () => runAgent(baseCfg({ llm, budgetMeter: meter })),
    )
    expect(llm.inputs.every((i) => i.onResponseHeaders === undefined)).toBe(true)
    expect(meter.providerRateLimitRemainingPercent()).toBeUndefined()
  })
})
