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
 * SECOND INVARIANT PINNED (jul-03 gap #2 — DECOUPLED): the provider-tap feed is
 * now reachable whenever the write-guard's `budgetMeter` is wired, INDEPENDENT of
 * the unrelated QUANTA_RATELIMIT_NOTICE/_PROACTIVE knob. With a meter present and
 * NEITHER rate-limit knob set, the hook STILL wires and the tap is fed (Codex OR
 * OpenAI/Anthropic count headers). With NO meter and no rate-limit knob, the hook
 * stays unwired (byte-identical — no over-broadening). MUTATION: reverting the
 * hook to the `rateLimitProactive`-only gate turns the decoupled pins RED.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { BudgetMeter, runAgent } from "@/agent"
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
  }, 30_000)

  test("NO-LEAK: remaining COUNT with no paired limit ⇒ tap stays undefined (never fabricate %)", async () => {
    // Post-broaden: `anthropic-ratelimit-tokens-remaining` IS a recognized header,
    // but the count→percent derivation needs its paired `-limit` denominator. A
    // remaining without a limit must NOT fabricate a percentage — the tap stays
    // undefined and the provider arm fails open (byte-identical). This pins that the
    // broadened source honors the NO-invented-number rule end-to-end in the loop.
    const meter = new BudgetMeter()
    const llm = new ScriptedLLM(toolThenFinal(), [
      { "anthropic-ratelimit-tokens-remaining": "9000" }, // remaining, but NO -limit
      undefined,
    ])
    await withKnobs({ QUANTA_RATELIMIT_NOTICE: "1" }, () =>
      runAgent(baseCfg({ llm, budgetMeter: meter })),
    )
    expect(meter.providerRateLimitRemainingPercent()).toBeUndefined()
  })

  test("DECOUPLED (gap #2): budgetMeter armed, NO rate-limit knob ⇒ hook STILL wired ⇒ tap fed", async () => {
    // jul-03 B3 audit gap #2: the write-guard's activation gate constructs the
    // `budgetMeter`. Its provider tap must be fed INDEPENDENTLY of the unrelated
    // QUANTA_RATELIMIT_NOTICE/_PROACTIVE knob. With NEITHER rate-limit knob set,
    // the header hook must STILL wire (because a meter is present) and a low-window
    // header must reach the meter tap the guard reads. MUTATION: reverting the hook
    // to the `rateLimitProactive`-only gate ⇒ hook undefined ⇒ tap undefined ⇒ RED.
    const meter = new BudgetMeter()
    const llm = new ScriptedLLM(toolThenFinal(), [
      { "x-codex-primary-used-percent": "99", "x-codex-primary-window-minutes": "300" },
      undefined,
    ])
    await withKnobs(
      { QUANTA_RATELIMIT_NOTICE: undefined, QUANTA_RATELIMIT_PROACTIVE: undefined },
      () => runAgent(baseCfg({ llm, budgetMeter: meter })),
    )
    // The hook wired PURELY because a budgetMeter is present (no rate-limit knob).
    expect(llm.inputs[0]?.onResponseHeaders).toBeDefined()
    // ...and fed 100 − 99 = 1 into the provider tap the guard reads.
    expect(meter.providerRateLimitRemainingPercent()).toBe(1)
  })

  test("DECOUPLED + BROADEN: OpenAI count header with NO rate-limit knob ⇒ tap fed across providers", async () => {
    // Both gaps at once: an OpenAI COUNT/limit header (not Codex used-percent),
    // with NEITHER rate-limit knob, must arm the tap purely off the write-guard's
    // meter. Proves the guard is armed on OpenAI/Anthropic, not just Codex.
    const meter = new BudgetMeter()
    const llm = new ScriptedLLM(toolThenFinal(), [
      { "x-ratelimit-remaining-requests": "7", "x-ratelimit-limit-requests": "100" },
      undefined,
    ])
    await withKnobs(
      { QUANTA_RATELIMIT_NOTICE: undefined, QUANTA_RATELIMIT_PROACTIVE: undefined },
      () => runAgent(baseCfg({ llm, budgetMeter: meter })),
    )
    expect(llm.inputs[0]?.onResponseHeaders).toBeDefined()
    expect(meter.providerRateLimitRemainingPercent()).toBe(7)
  })

  test("BYTE-IDENTICAL: NO meter AND no rate-limit knob ⇒ hook stays unwired (no over-wiring)", async () => {
    // The decoupling must NOT wire the hook when there is nothing to feed: with no
    // budgetMeter and no rate-limit knob, `onResponseHeaders` must stay undefined
    // (byte-identical to the pre-B3 no-hook path). Guards against over-broadening.
    const llm = new ScriptedLLM(toolThenFinal(), [
      { "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "300" },
      undefined,
    ])
    await withKnobs(
      { QUANTA_RATELIMIT_NOTICE: undefined, QUANTA_RATELIMIT_PROACTIVE: undefined },
      () => runAgent(baseCfg({ llm })), // no budgetMeter
    )
    expect(llm.inputs.every((i) => i.onResponseHeaders === undefined)).toBe(true)
  })
})
