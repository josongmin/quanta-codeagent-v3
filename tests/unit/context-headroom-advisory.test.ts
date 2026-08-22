/**
 * RFC-01 A7 (aug-02 absorption) — context-headroom advisory.
 *
 * Two layers:
 *  1. PURE latch (`stepHeadroomLatch`) — the edge-triggered crossing math:
 *     below→above→above→reset→above yields exactly TWO emit edges, and the
 *     degenerate/zero-window cases never cross.
 *  2. PRODUCT / FRONT-DOOR — drive the REAL `maybeCompact` wire with a
 *     capturing `stream.emit` and prove:
 *       - gate ON ⇒ exactly ONE `context_headroom_crossed` event with the
 *         existing used/limit/threshold numbers;
 *       - the event is observability-only (compaction still happens; the loop
 *         is not stopped);
 *       - gate OFF ⇒ ZERO headroom events (byte-identical default-OFF).
 *
 * Red-on-injection: dropping the `stepHeadroomLatch` disarm (emit-once) makes
 * the "above→above" step re-emit (count 3, not 2); removing the gate-OFF guard
 * makes the OFF case emit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { type HeadroomLatchState, stepHeadroomLatch } from "@/agent/compaction/index"
import { maybeCompact } from "@/agent/loop/compaction-wire"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent } from "@/stream"

/* ------------------------------------------------------------------ */
/* 1. pure latch                                                       */
/* ------------------------------------------------------------------ */

describe("stepHeadroomLatch — edge-latched crossing (RFC01-1)", () => {
  const THRESHOLD = 1_000
  const LIMIT = 1_000
  const step = (latch: HeadroomLatchState, used: number) =>
    stepHeadroomLatch(latch, { usedTokens: used, limitTokens: LIMIT }, THRESHOLD, THRESHOLD)

  test("below → above → above → reset → above ⇒ exactly 2 crossings", () => {
    const latch: HeadroomLatchState = { armed: true }
    const seq = [
      500, // below — no cross
      1_200, // ABOVE — cross #1, disarm
      1_300, // still above — NO re-emit (latched)
      400, // reset below threshold — re-arm
      1_100, // ABOVE — cross #2
    ]
    const crossings = seq.map((used) => step(latch, used).crossed)
    expect(crossings).toEqual([false, true, false, false, true])
    expect(crossings.filter(Boolean).length).toBe(2)
  })

  test("staying above never re-emits without a reset", () => {
    const latch: HeadroomLatchState = { armed: true }
    const c = [1_100, 1_500, 2_000, 5_000].map((u) => step(latch, u).crossed)
    expect(c).toEqual([true, false, false, false])
  })

  test("crossing carries the exact existing numbers (no derived fields)", () => {
    const latch: HeadroomLatchState = { armed: true }
    const out = stepHeadroomLatch(latch, { usedTokens: 1_234, limitTokens: 2_000 }, 1_000, 1_000)
    expect(out).toEqual({
      crossed: true,
      usedTokens: 1_234,
      limitTokens: 2_000,
      thresholdTokens: 1_000,
    })
  })

  test("degenerate window (limit<=0 or threshold<=0) never crosses", () => {
    const latch: HeadroomLatchState = { armed: true }
    expect(
      stepHeadroomLatch(latch, { usedTokens: 9_999, limitTokens: 0 }, 1_000, 1_000).crossed,
    ).toBe(false)
    expect(stepHeadroomLatch(latch, { usedTokens: 9_999, limitTokens: 1_000 }, 0, 0).crossed).toBe(
      false,
    )
  })

  test("exact-threshold hit counts as a crossing (>= boundary)", () => {
    const latch: HeadroomLatchState = { armed: true }
    expect(step(latch, 1_000).crossed).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* 2. product / front-door — real maybeCompact wire                    */
/* ------------------------------------------------------------------ */

class FakeSummarizerLLM implements LLMPort {
  readonly model = "scripted"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "FOLDED" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const u = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const a = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] })

/** Over-threshold, multi-turn so `before` far exceeds the low threshold. */
const overThreshold = (): Message[] => [
  u("x".repeat(4_000)),
  a("y".repeat(4_000)),
  u("recent ask"),
  a("recent answer"),
]

const fakeWm = (initial: Message[]) => {
  const buf = [...initial]
  return {
    messages: buf,
    append: (x: Message) => buf.push(x),
    snapshot: () => buf,
    clear: () => {
      buf.length = 0
    },
    replace: (xs: Message[]) => {
      buf.length = 0
      buf.push(...xs)
    },
    tokenEstimate: () => 0,
  }
}

const cfgWith = (cap: AgentEvent[], sessionId = "sess-h"): AgentConfig =>
  ({
    llm: new FakeSummarizerLLM(),
    system: "sys",
    cwd: "/tmp",
    compaction: { thresholdTokens: 100, keepRecentTurns: 1 },
    sessionId,
    stream: {
      emit: (e: AgentEvent) => {
        cap.push(e)
      },
    },
  }) as unknown as AgentConfig

const runWire = async (cfg: AgentConfig, wm: ReturnType<typeof fakeWm>, turn: number) =>
  maybeCompact({
    config: cfg,
    system: "sys",
    wm: wm as never,
    breaker: undefined,
    archive: undefined,
    turn,
    bgController: undefined,
    resetClassifier: () => {},
    tokenBaselineBox: undefined,
  })

const headroomEvents = (cap: AgentEvent[]) =>
  cap.filter((e) => e.type === "context_headroom_crossed")

describe("context-headroom advisory — REAL maybeCompact wire (RFC01-1)", () => {
  let envSnapshot: NodeJS.ProcessEnv
  beforeEach(() => {
    envSnapshot = { ...process.env }
  })
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test("gate ON ⇒ exactly one headroom event carrying used/limit/threshold", async () => {
    process.env.QUANTA_CONTEXT_HEADROOM_ADVISORY = "1"
    __resetRuntimeConfig()
    const cap: AgentEvent[] = []
    const cfg = cfgWith(cap, "sess-on")
    const wm = fakeWm(overThreshold())
    await runWire(cfg, wm, 1)
    const hits = headroomEvents(cap)
    expect(hits.length).toBe(1)
    const ev = hits[0]
    if (ev?.type !== "context_headroom_crossed") throw new Error("missing event")
    expect(ev.usedTokens).toBeGreaterThan(0)
    expect(ev.limitTokens).toBe(100) // the existing compaction threshold
    expect(ev.thresholdTokens).toBe(100)
    // Observability-only: the compaction actually fired (transcript folded),
    // proving the advisory did not replace or gate the compaction path.
    expect(wm.messages.length).toBeLessThan(overThreshold().length)
  })

  test("second turn still above ⇒ no re-emit (edge-latched across turns)", async () => {
    process.env.QUANTA_CONTEXT_HEADROOM_ADVISORY = "1"
    __resetRuntimeConfig()
    const cap: AgentEvent[] = []
    const cfg = cfgWith(cap, "sess-latch")
    // Same session across two calls: after the first compaction the wm shrinks,
    // but even a fresh over-threshold wm on the SAME session must not re-emit
    // until usage dropped below the threshold between them.
    await runWire(cfg, fakeWm(overThreshold()), 1)
    await runWire(cfg, fakeWm(overThreshold()), 2)
    expect(headroomEvents(cap).length).toBe(1)
  })

  test("gate OFF ⇒ ZERO headroom events (byte-identical default-OFF)", async () => {
    delete process.env.QUANTA_CONTEXT_HEADROOM_ADVISORY
    __resetRuntimeConfig()
    const cap: AgentEvent[] = []
    const cfg = cfgWith(cap, "sess-off")
    await runWire(cfg, fakeWm(overThreshold()), 1)
    expect(headroomEvents(cap).length).toBe(0)
  })
})
