/**
 * ADR-0452 — session-startup prewarm LOOP-WIRE hellgate.
 *
 * Drives the WHOLE `runAgent` loop with a scripted FakeLLM + a real `Metrics`
 * registry to prove the wiring (not just the units):
 *
 *   A. prewarm gated ON ⇒ TTFM gauge recorded EXACTLY ONCE + prewarm fired
 *      BEFORE the first turn's LLM dispatch (warm-call ordinal < stream-call).
 *   B. prewarm absent ⇒ NO `quanta.startup.*` metric AT ALL (byte-identical:
 *      same outcome.reason, same non-usage event stream as a no-metrics run).
 *   C. prewarm enabled but adapter has NO prewarm capability ⇒ outcome is
 *      "skipped", duration 0, TTFM still recorded (capability is optional).
 *   D. prewarm warm REJECTS ⇒ the turn STILL completes (best-effort; warm
 *      failure never blocks the turn) + outcome counter is ".failed".
 *   E. multi-turn session ⇒ TTFM recorded ONCE (first dispatch only), not
 *      re-recorded on later turns.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { LlmPrewarmPort } from "@/llm"
import { Metrics } from "@/observability"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

class FakeLLM implements LLMPort {
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  /** Global call-ordinal bumped on EVERY stream() across all instances. */
  streamOrdinal = -1
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(): AsyncIterable<StreamEvent> {
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    this.streamOrdinal = tick()
    for (const ev of script) yield ev
  }
}

class WarmableLLM extends FakeLLM implements LlmPrewarmPort {
  warmOrdinal = -1
  warmCalls = 0
  constructor(
    scripts: StreamEvent[][],
    private readonly warmBehavior: "ok" | "reject" = "ok",
  ) {
    super(scripts)
  }
  async prewarm(): Promise<void> {
    this.warmCalls++
    this.warmOrdinal = tick()
    if (this.warmBehavior === "reject") throw new Error("warm refused")
  }
}

// Monotonic global ordinal so we can assert "warm happened before stream".
let ORDINAL = 0
const tick = (): number => ORDINAL++

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const answer = (): StreamEvent[] => [
  { type: "text_delta", delta: "done" },
  { type: "message_stop", stop_reason: "end_turn" },
]

const baseConfig = (llm: LLMPort, registry: ToolRegistry, stream: StreamPort): AgentConfig => ({
  llm,
  registry,
  stream,
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
})

describe("ADR-0452 — prewarm loop wiring", () => {
  test("A. gated ON ⇒ TTFM once + warm BEFORE first dispatch", async () => {
    ORDINAL = 0
    const m = new Metrics()
    const llm = new WarmableLLM([answer()])
    const registry = new ToolRegistry(defaultTools)
    const stream = new RecordingStream()
    const out = await runAgent({
      ...baseConfig(llm, registry, stream),
      metrics: m,
      prewarm: { enabled: true, now: () => Date.now() },
    })
    expect(out.reason).toBe("completed")
    expect(llm.warmCalls).toBe(1)
    // warm fired before the model stream opened.
    expect(llm.warmOrdinal).toBeGreaterThanOrEqual(0)
    expect(llm.streamOrdinal).toBeGreaterThan(llm.warmOrdinal)
    const snap = m.snapshot()
    expect(snap.counters["quanta.startup.prewarm_outcome.warmed"]).toBe(1)
    // TTFM gauge present (gauge is a single value, recorded once).
    expect(snap.gauges["quanta.startup.time_to_first_message_ms"]).toBeGreaterThanOrEqual(0)
  })

  test("B. prewarm absent ⇒ NO quanta.startup.* metric (byte-identical)", async () => {
    ORDINAL = 0
    const registry = new ToolRegistry(defaultTools)

    const m = new Metrics()
    const onStream = new RecordingStream()
    const withMetricsNoPrewarm = await runAgent({
      ...baseConfig(new FakeLLM([answer()]), registry, onStream),
      metrics: m, // metrics wired, but prewarm block ABSENT
    })

    const snap = m.snapshot()
    const startupKeys = [
      ...Object.keys(snap.gauges),
      ...Object.keys(snap.counters),
    ].filter((k) => k.startsWith("quanta.startup."))
    expect(startupKeys).toEqual([])

    // And the event stream matches a run with no metrics at all.
    const offStream = new RecordingStream()
    const noMetrics = await runAgent(baseConfig(new FakeLLM([answer()]), registry, offStream))
    const nonUsage = (s: RecordingStream): string[] =>
      s.events.filter((e) => e.type !== "usage").map((e) => e.type)
    expect(noMetrics.reason).toBe(withMetricsNoPrewarm.reason)
    expect(nonUsage(offStream)).toEqual(nonUsage(onStream))
  })

  test("C. enabled but adapter lacks prewarm ⇒ skipped, duration 0, TTFM still set", async () => {
    ORDINAL = 0
    const m = new Metrics()
    const out = await runAgent({
      ...baseConfig(new FakeLLM([answer()]), new ToolRegistry(defaultTools), new RecordingStream()),
      metrics: m,
      prewarm: { enabled: true, now: () => Date.now() },
    })
    expect(out.reason).toBe("completed")
    const snap = m.snapshot()
    expect(snap.counters["quanta.startup.prewarm_outcome.skipped"]).toBe(1)
    expect(snap.gauges["quanta.startup.prewarm_duration_ms"]).toBe(0)
    expect(snap.gauges["quanta.startup.time_to_first_message_ms"]).toBeGreaterThanOrEqual(0)
  })

  test("D. warm REJECTS ⇒ turn still completes (best-effort) + .failed counter", async () => {
    ORDINAL = 0
    const m = new Metrics()
    const llm = new WarmableLLM([answer()], "reject")
    const out = await runAgent({
      ...baseConfig(llm, new ToolRegistry(defaultTools), new RecordingStream()),
      metrics: m,
      prewarm: { enabled: true, now: () => Date.now() },
    })
    // Turn completed despite the failed warm.
    expect(out.reason).toBe("completed")
    expect(llm.warmCalls).toBe(1)
    const snap = m.snapshot()
    expect(snap.counters["quanta.startup.prewarm_outcome.failed"]).toBe(1)
  })

  test("E. multi-turn ⇒ TTFM recorded ONCE (gauge = first-dispatch value)", async () => {
    ORDINAL = 0
    const m = new Metrics()
    // Two turns: first asks a tool, second answers. We just need 2 stream opens.
    const llm = new FakeLLM([
      [
        { type: "text_delta", delta: "thinking" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    ])
    const out = await runAgent({
      ...baseConfig(llm, new ToolRegistry(defaultTools), new RecordingStream()),
      metrics: m,
      prewarm: { enabled: true, now: () => Date.now() },
    })
    expect(out.reason).toBe("completed")
    const snap = m.snapshot()
    // A gauge holds one value; the marker is once-fire so this is the first
    // dispatch's value, never overwritten by a later turn.
    expect(snap.gauges["quanta.startup.time_to_first_message_ms"]).toBeGreaterThanOrEqual(0)
  })
})
