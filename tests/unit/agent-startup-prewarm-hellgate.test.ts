/**
 * ADR-0452 — session-startup LLM prewarm + Time-To-First-Message hellgate.
 *
 * Proves the seam end-to-end at the unit boundary (the loop wires these exact
 * collaborators):
 *
 *   - `prewarmLlm` (src/llm/prewarm.ts): the connection-warm boundary.
 *   - `runSessionPrewarm` (src/agent/startup-prewarm.ts): the once-fire TTFM
 *     marker + prewarm-outcome metric, all from an INJECTED clock.
 *   - `AgentRecorder.prewarm` / `.timeToFirstMessage`: the canonical
 *     `quanta.startup.*` metric emission.
 *
 * Pins:
 *   A. port WITHOUT `prewarm` capability ⇒ `prewarmLlm` returns "skipped",
 *      NEVER touches the port (true no-op).
 *   B. port WITH `prewarm` ⇒ called exactly once, "warmed".
 *   C. `prewarm()` that REJECTS ⇒ swallowed → "failed", onError fired, NO throw
 *      (warm failure never blocks the turn).
 *   D. TTFM recorded from the INJECTED clock: now()-startedAt, deterministic.
 *   E. TTFM marker fires ONCE — a second markFirstDispatch() is a no-op
 *      (single per-session value, Codex age_at_first_turn_ms parity).
 *   F. recorder absent ⇒ prewarm still runs (no throw), no metric.
 *   G. skipped outcome ⇒ prewarm_duration_ms gauge is 0 (no warm happened).
 *   H. canonical metric KEYS land under quanta.startup.* (vocabulary parity).
 *   I. signal threaded through to the port's prewarm.
 *   J. metric is byte-absent until markFirstDispatch() is called (no premature
 *      TTFM at session start).
 */

import { describe, expect, test } from "bun:test"
import { AgentRecorder } from "@/agent"
import { runSessionPrewarm } from "@/agent/startup-prewarm"
import { type LlmPrewarmPort, prewarmLlm } from "@/llm"
import type { LLMPort } from "@/llm"
import { Metrics } from "@/observability"
import type { StreamEvent, StreamInput } from "@/llm/types"

// A bare LLMPort with NO prewarm capability.
const bareLlm = (): LLMPort => ({
  // biome-ignore lint/correctness/useYield: empty stub stream, never consumed
  stream: async function* (_input: StreamInput): AsyncIterable<StreamEvent> {
    /* never called in these tests */
  },
})

// An LLMPort that also implements the optional prewarm capability.
const warmableLlm = (
  prewarmImpl: (signal?: AbortSignal) => Promise<void>,
): LLMPort & LlmPrewarmPort => ({
  ...bareLlm(),
  prewarm: prewarmImpl,
})

// Deterministic fake clock: returns the queued values in order, then holds the
// last value.
const fakeClock = (...values: number[]): (() => number) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

describe("ADR-0452 — prewarmLlm connection-warm boundary", () => {
  test("A. port without prewarm ⇒ skipped, never touches the port", async () => {
    const outcome = await prewarmLlm(bareLlm())
    expect(outcome).toBe("skipped")
  })

  test("B. port with prewarm ⇒ called once, warmed", async () => {
    let calls = 0
    const port = warmableLlm(async () => {
      calls++
    })
    const outcome = await prewarmLlm(port)
    expect(outcome).toBe("warmed")
    expect(calls).toBe(1)
  })

  test("C. prewarm rejects ⇒ failed, onError fired, NO throw", async () => {
    const errs: string[] = []
    const port = warmableLlm(async () => {
      throw new Error("handshake refused")
    })
    let outcome: string | undefined
    // Must not throw.
    await expect(
      (async () => {
        outcome = await prewarmLlm(port, { onError: (m) => errs.push(m) })
      })(),
    ).resolves.toBeUndefined()
    expect(outcome).toBe("failed")
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain("handshake refused")
  })

  test("I. signal threaded through to port.prewarm", async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    const port = warmableLlm(async (signal) => {
      seen = signal
    })
    await prewarmLlm(port, { signal: ac.signal })
    expect(seen).toBe(ac.signal)
  })
})

describe("ADR-0452 — runSessionPrewarm TTFM + metrics", () => {
  test("D. TTFM = now()-startedAt from the injected clock (deterministic)", async () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    // bare (skipped) path reads the clock twice at start (startedAt=1000,
    // warmBegan=1000; skipped ⇒ NO afterWarm read) then once at dispatch=1250.
    const marker = await runSessionPrewarm({
      llm: bareLlm(),
      recorder: rec,
      now: fakeClock(1000, 1000, 1250),
    })
    marker.markFirstDispatch()
    const snap = m.snapshot()
    expect(snap.gauges["quanta.startup.time_to_first_message_ms"]).toBe(250)
  })

  test("E. marker fires ONCE — second markFirstDispatch is a no-op", async () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    const marker = await runSessionPrewarm({
      llm: bareLlm(),
      recorder: rec,
      // startedAt=1000, warmBegan=1000 (skipped, no afterWarm), dispatch=1100
      // (TTFM=100); a SECOND dispatch would read 9999 but the marker is once-fire.
      now: fakeClock(1000, 1000, 1100, 9999),
    })
    marker.markFirstDispatch()
    marker.markFirstDispatch() // no-op
    const snap = m.snapshot()
    expect(snap.gauges["quanta.startup.time_to_first_message_ms"]).toBe(100)
  })

  test("F. recorder absent ⇒ prewarm runs, no throw, no metric", async () => {
    let warmed = 0
    const port = warmableLlm(async () => {
      warmed++
    })
    const marker = await runSessionPrewarm({
      llm: port,
      recorder: undefined,
      now: fakeClock(1000, 1000, 1010, 1100),
    })
    expect(warmed).toBe(1)
    // markFirstDispatch with no recorder must not throw.
    expect(() => marker.markFirstDispatch()).not.toThrow()
  })

  test("G. skipped outcome ⇒ prewarm_duration_ms gauge is 0", async () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    await runSessionPrewarm({
      llm: bareLlm(), // no prewarm ⇒ skipped
      recorder: rec,
      now: fakeClock(1000, 1000, 1500), // even if clock advances, skipped ⇒ 0
    })
    const snap = m.snapshot()
    expect(snap.gauges["quanta.startup.prewarm_duration_ms"]).toBe(0)
    expect(snap.counters["quanta.startup.prewarm_outcome.skipped"]).toBe(1)
  })

  test("warmed outcome ⇒ duration measured from injected clock", async () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    const port = warmableLlm(async () => {})
    // startedAt=1000 ; warmBegan=1000 ; afterWarm=1040
    await runSessionPrewarm({
      llm: port,
      recorder: rec,
      now: fakeClock(1000, 1000, 1040),
    })
    const snap = m.snapshot()
    expect(snap.gauges["quanta.startup.prewarm_duration_ms"]).toBe(40)
    expect(snap.counters["quanta.startup.prewarm_outcome.warmed"]).toBe(1)
  })

  test("failed outcome ⇒ counter .failed, never throws", async () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    const port = warmableLlm(async () => {
      throw new Error("boom")
    })
    const marker = await runSessionPrewarm({
      llm: port,
      recorder: rec,
      now: fakeClock(1000, 1000, 1005, 1100),
    })
    marker.markFirstDispatch()
    const snap = m.snapshot()
    expect(snap.counters["quanta.startup.prewarm_outcome.failed"]).toBe(1)
    // TTFM still recorded even though the warm failed.
    expect(snap.gauges["quanta.startup.time_to_first_message_ms"]).toBe(100)
  })

  test("H. metric keys land under canonical quanta.startup.* namespace", async () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    const marker = await runSessionPrewarm({
      llm: bareLlm(),
      recorder: rec,
      now: fakeClock(1000, 1000, 1000, 1010),
    })
    marker.markFirstDispatch()
    const snap = m.snapshot()
    const keys = [...Object.keys(snap.gauges), ...Object.keys(snap.counters)]
    expect(keys.every((k) => k.startsWith("quanta.startup."))).toBe(true)
  })

  test("J. TTFM is absent until markFirstDispatch() is called", async () => {
    const m = new Metrics()
    const rec = new AgentRecorder(m)
    await runSessionPrewarm({
      llm: bareLlm(),
      recorder: rec,
      now: fakeClock(1000, 1000, 1000),
    })
    // No markFirstDispatch yet ⇒ no TTFM gauge.
    const snap = m.snapshot()
    expect(snap.gauges["quanta.startup.time_to_first_message_ms"]).toBeUndefined()
  })

  test("signal forwarded from runSessionPrewarm to the port", async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    const port = warmableLlm(async (signal) => {
      seen = signal
    })
    await runSessionPrewarm({
      llm: port,
      recorder: undefined,
      now: fakeClock(1000, 1000, 1010),
      warmSignal: ac.signal,
    })
    expect(seen).toBe(ac.signal)
  })
})
