/**
 * FallbackLLM — metric-emission hellgate (post `fe8ff51b` instrumentation).
 *
 * Sibling to `fallback-hellgate.test.ts` / `fallback.test.ts` /
 * `fallback-empty-tombstone.test.ts` (which pin stream-correctness +
 * tombstone semantics + non-trigger rethrow). THIS file pins the
 * INSTRUMENTATION layer (commit `fe8ff51b`) — `FALLBACK_METRIC_NAMES.attempt
 * / .triggered / .exhausted` emissions and the no-emit guarantees.
 *
 * Coverage gap closed:
 *   - No existing test asserts emit-COUNT or LABEL shape on the metric sink.
 *   - First adversarial probe of "noop sink when undefined" + "sink throw
 *     does not break stream" + "labels structurally correct" + "exhaust
 *     emits exactly once with last_kind".
 *
 * 14 distinct cases.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent } from "@/llm"
import { FALLBACK_METRIC_NAMES, FallbackLLM, type FallbackMetricSink } from "@/llm"
import { LLMError } from "@/shared"

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

type Step =
  | { kind: "ok"; events: StreamEvent[]; model?: string }
  | { kind: "throw"; error: unknown; model?: string }
  | { kind: "yieldThenThrow"; events: StreamEvent[]; error: unknown; model?: string }

class ScriptedLLM implements LLMPort {
  readonly model?: string
  constructor(private readonly step: Step) {
    if (step.model !== undefined) this.model = step.model
  }
  async *stream(): AsyncIterable<StreamEvent> {
    if (this.step.kind === "ok") {
      for (const ev of this.step.events) yield ev
      return
    }
    if (this.step.kind === "yieldThenThrow") {
      for (const ev of this.step.events) yield ev
      throw this.step.error
    }
    throw this.step.error
  }
}

type Emit = { name: string; delta?: number; labels?: Record<string, string> }

const makeSink = (mode: "ok" | "throw" = "ok"): FallbackMetricSink & { emits: Emit[] } => {
  const emits: Emit[] = []
  return {
    emits,
    increment(name, delta, labels) {
      emits.push({
        name,
        ...(delta !== undefined ? { delta } : {}),
        ...(labels !== undefined ? { labels } : {}),
      })
      if (mode === "throw") throw new Error("sink boom")
    },
  }
}

const overload = (msg = "overloaded"): LLMError =>
  new LLMError(msg, { kind: "overloaded", statusCode: 529 })
const authErr = (): LLMError => new LLMError("auth", { kind: "auth", statusCode: 401 })
const text = (t: string): StreamEvent => ({ type: "text_delta", delta: t })
const stop = (): StreamEvent => ({ type: "message_stop", stop_reason: "end_turn" })

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const countsByName = (emits: Emit[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const e of emits) out[e.name] = (out[e.name] ?? 0) + 1
  return out
}

// ─────────────────────────────────────────────────────────────
// A. metrics-sink wiring (4)
// ─────────────────────────────────────────────────────────────

describe("FallbackLLM metrics — A. sink wiring", () => {
  test("METRIC-1: no `metrics` opt → ZERO emits even with a successful primary (noop sentinel)", async () => {
    // Default-OFF posture (fallback.ts L20-L22): the noop sink emits nothing.
    // The chain must run byte-identical to pre-instrumentation.
    const primary = new ScriptedLLM({
      kind: "ok",
      events: [text("hi"), stop()],
      model: "alpha",
    })
    const llm = new FallbackLLM({ providers: [primary] }) // no metrics
    const events = await drain(llm.stream({} as never))
    // Stream still works — assembled output unchanged.
    expect(events.find((e) => e.type === "text_delta")).toBeDefined()
    expect(events.find((e) => e.type === "message_stop")).toBeDefined()
    // NOTHING to assert on emits — sink is private noop. The negative test is
    // that the chain didn't throw and behavior matches pre-fe8ff51b shape.
  })

  test("METRIC-2: sink wired + primary succeeds → exactly ONE `attempt` emit (NOT `triggered`, NOT `exhausted`)", async () => {
    const sink = makeSink()
    const primary = new ScriptedLLM({
      kind: "ok",
      events: [text("hi"), stop()],
      model: "alpha",
    })
    const llm = new FallbackLLM({ providers: [primary], metrics: sink })
    await drain(llm.stream({} as never))
    const counts = countsByName(sink.emits)
    expect(counts[FALLBACK_METRIC_NAMES.attempt]).toBe(1)
    expect(counts[FALLBACK_METRIC_NAMES.triggered]).toBeUndefined()
    expect(counts[FALLBACK_METRIC_NAMES.exhausted]).toBeUndefined()
    // Attempt labels include model + index="0".
    const attempt = sink.emits.find((e) => e.name === FALLBACK_METRIC_NAMES.attempt)
    expect(attempt?.labels?.model).toBe("alpha")
    expect(attempt?.labels?.index).toBe("0")
    // Delta is always 1.
    expect(attempt?.delta).toBe(1)
  })

  test("METRIC-3: sink that THROWS on increment → stream STILL completes (observability cannot break the stream)", async () => {
    // fallback.ts L159-L165: emit wraps increment in try/catch. A misbehaving
    // dashboard cannot corrupt the LLM stream.
    const sink = makeSink("throw")
    const primary = new ScriptedLLM({
      kind: "ok",
      events: [text("ok"), stop()],
      model: "alpha",
    })
    const llm = new FallbackLLM({ providers: [primary], metrics: sink })
    const events = await drain(llm.stream({} as never))
    expect(events.find((e) => e.type === "message_stop")).toBeDefined()
    // The sink WAS called (recorded its emit before throwing).
    expect(sink.emits.length).toBeGreaterThanOrEqual(1)
  })

  test("METRIC-4: attempt model label `unknown` when provider has no model property", async () => {
    const sink = makeSink()
    const primary = new ScriptedLLM({ kind: "ok", events: [text("x"), stop()] }) // no model
    const llm = new FallbackLLM({ providers: [primary], metrics: sink })
    await drain(llm.stream({} as never))
    const attempt = sink.emits.find((e) => e.name === FALLBACK_METRIC_NAMES.attempt)
    expect(attempt?.labels?.model).toBe("unknown")
  })
})

// ─────────────────────────────────────────────────────────────
// B. triggered emit on swap (4)
// ─────────────────────────────────────────────────────────────

describe("FallbackLLM metrics — B. triggered", () => {
  test("METRIC-5: pre-yield overload swap → ONE `triggered` with post_yield='false', AND ONE attempt per provider", async () => {
    // Primary throws before any yield; fallback succeeds. Trigger ONCE.
    const sink = makeSink()
    const p1 = new ScriptedLLM({ kind: "throw", error: overload(), model: "primary" })
    const p2 = new ScriptedLLM({ kind: "ok", events: [text("ok"), stop()], model: "fallback" })
    const llm = new FallbackLLM({ providers: [p1, p2], metrics: sink })
    await drain(llm.stream({} as never))
    const counts = countsByName(sink.emits)
    expect(counts[FALLBACK_METRIC_NAMES.attempt]).toBe(2)
    expect(counts[FALLBACK_METRIC_NAMES.triggered]).toBe(1)
    expect(counts[FALLBACK_METRIC_NAMES.exhausted]).toBeUndefined()
    const trig = sink.emits.find((e) => e.name === FALLBACK_METRIC_NAMES.triggered)
    expect(trig?.labels?.from).toBe("primary")
    expect(trig?.labels?.to).toBe("fallback")
    expect(trig?.labels?.kind).toBe("overloaded")
    expect(trig?.labels?.post_yield).toBe("false")
  })

  test("METRIC-6: post-yield swap → ONE `triggered` with post_yield='true' (distinguishes mid-stream disruption)", async () => {
    const sink = makeSink()
    const p1 = new ScriptedLLM({
      kind: "yieldThenThrow",
      events: [text("partial-a")],
      error: overload(),
      model: "primary",
    })
    const p2 = new ScriptedLLM({ kind: "ok", events: [text("ok"), stop()], model: "fallback" })
    const llm = new FallbackLLM({ providers: [p1, p2], metrics: sink })
    await drain(llm.stream({} as never))
    const trig = sink.emits.find((e) => e.name === FALLBACK_METRIC_NAMES.triggered)
    expect(trig).toBeDefined()
    expect(trig?.labels?.post_yield).toBe("true")
    expect(trig?.labels?.from).toBe("primary")
    expect(trig?.labels?.to).toBe("fallback")
  })

  test("METRIC-7: multi-level fallback (2 swaps before success) → exactly TWO `triggered` emits, ONE per swap", async () => {
    const sink = makeSink()
    const p1 = new ScriptedLLM({ kind: "throw", error: overload(), model: "m1" })
    const p2 = new ScriptedLLM({ kind: "throw", error: overload(), model: "m2" })
    const p3 = new ScriptedLLM({ kind: "ok", events: [text("ok"), stop()], model: "m3" })
    const llm = new FallbackLLM({ providers: [p1, p2, p3], metrics: sink })
    await drain(llm.stream({} as never))
    const counts = countsByName(sink.emits)
    expect(counts[FALLBACK_METRIC_NAMES.triggered]).toBe(2)
    expect(counts[FALLBACK_METRIC_NAMES.attempt]).toBe(3)
    expect(counts[FALLBACK_METRIC_NAMES.exhausted]).toBeUndefined()
    // First trigger: m1→m2. Second: m2→m3.
    const trigs = sink.emits.filter((e) => e.name === FALLBACK_METRIC_NAMES.triggered)
    expect(trigs[0]?.labels?.from).toBe("m1")
    expect(trigs[0]?.labels?.to).toBe("m2")
    expect(trigs[1]?.labels?.from).toBe("m2")
    expect(trigs[1]?.labels?.to).toBe("m3")
  })

  test("METRIC-8: non-trigger error (auth) → NO `triggered` emit, NO `exhausted`, rethrows immediately", async () => {
    // fallback.ts L237-L247: non-trigger errors rethrow without emitting the
    // swap counter (the emit is INSIDE the `else` branch). On the last
    // provider, `exhausted` IS emitted regardless of trigger kind.
    const sink = makeSink()
    const p1 = new ScriptedLLM({ kind: "throw", error: authErr(), model: "p1" })
    const p2 = new ScriptedLLM({ kind: "ok", events: [text("ok"), stop()], model: "p2" })
    const llm = new FallbackLLM({ providers: [p1, p2], metrics: sink })
    let threw: unknown = null
    try {
      await drain(llm.stream({} as never))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(LLMError)
    const counts = countsByName(sink.emits)
    // Only the primary's attempt emit; no swap, no exhausted (auth isn't last-attempt path).
    expect(counts[FALLBACK_METRIC_NAMES.attempt]).toBe(1)
    expect(counts[FALLBACK_METRIC_NAMES.triggered]).toBeUndefined()
    // p1 was NOT the last index in providers, so exhausted not emitted either.
    expect(counts[FALLBACK_METRIC_NAMES.exhausted]).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────
// C. exhausted emit + label correctness (3)
// ─────────────────────────────────────────────────────────────

describe("FallbackLLM metrics — C. exhausted", () => {
  test("METRIC-9: all providers overload → ONE `exhausted` emit with last_kind='overloaded'", async () => {
    const sink = makeSink()
    const p1 = new ScriptedLLM({ kind: "throw", error: overload(), model: "p1" })
    const p2 = new ScriptedLLM({ kind: "throw", error: overload(), model: "p2" })
    const llm = new FallbackLLM({ providers: [p1, p2], metrics: sink })
    let threw: unknown = null
    try {
      await drain(llm.stream({} as never))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(LLMError)
    const counts = countsByName(sink.emits)
    expect(counts[FALLBACK_METRIC_NAMES.exhausted]).toBe(1)
    expect(counts[FALLBACK_METRIC_NAMES.attempt]).toBe(2)
    // Triggered emitted for the swap from p1→p2 (still in the chain), but NOT
    // for p2's failure (p2 is the last — straight to exhausted).
    expect(counts[FALLBACK_METRIC_NAMES.triggered]).toBe(1)
    const exh = sink.emits.find((e) => e.name === FALLBACK_METRIC_NAMES.exhausted)
    expect(exh?.labels?.last_kind).toBe("overloaded")
  })

  test("METRIC-10: exhausted with last non-trigger error → last_kind reflects final error's actual kind", async () => {
    // p1 overloads (swap, triggered), p2 auth (non-trigger, last → exhausted
    // emitted with last_kind='auth' per the `isLast` branch).
    const sink = makeSink()
    const p1 = new ScriptedLLM({ kind: "throw", error: overload(), model: "p1" })
    const p2 = new ScriptedLLM({ kind: "throw", error: authErr(), model: "p2" })
    const llm = new FallbackLLM({ providers: [p1, p2], metrics: sink })
    let threw: unknown = null
    try {
      await drain(llm.stream({} as never))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(LLMError)
    const exh = sink.emits.find((e) => e.name === FALLBACK_METRIC_NAMES.exhausted)
    expect(exh).toBeDefined()
    expect(exh?.labels?.last_kind).toBe("auth")
  })

  test("METRIC-11: single-provider chain that fails → ONLY `exhausted` emit (no `triggered`)", async () => {
    const sink = makeSink()
    const p1 = new ScriptedLLM({ kind: "throw", error: overload(), model: "solo" })
    const llm = new FallbackLLM({ providers: [p1], metrics: sink })
    let threw: unknown = null
    try {
      await drain(llm.stream({} as never))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(LLMError)
    const counts = countsByName(sink.emits)
    expect(counts[FALLBACK_METRIC_NAMES.attempt]).toBe(1)
    expect(counts[FALLBACK_METRIC_NAMES.triggered]).toBeUndefined()
    expect(counts[FALLBACK_METRIC_NAMES.exhausted]).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────
// D. metric-name constants + emit shape (3)
// ─────────────────────────────────────────────────────────────

describe("FallbackLLM metrics — D. constants + shape", () => {
  test("METRIC-12: FALLBACK_METRIC_NAMES is a FROZEN object with the three pinned names", () => {
    // Pinned by source (fallback.ts L26-L30): Object.freeze. Dashboards depend
    // on these EXACT strings.
    expect(Object.isFrozen(FALLBACK_METRIC_NAMES)).toBe(true)
    expect(FALLBACK_METRIC_NAMES.attempt).toBe("llm.fallback.attempt.total")
    expect(FALLBACK_METRIC_NAMES.triggered).toBe("llm.fallback.triggered.total")
    expect(FALLBACK_METRIC_NAMES.exhausted).toBe("llm.fallback.exhausted.total")
  })

  test("METRIC-13: every emit carries delta=1 (counter semantics — not gauge/sum)", async () => {
    const sink = makeSink()
    const p1 = new ScriptedLLM({ kind: "throw", error: overload(), model: "p1" })
    const p2 = new ScriptedLLM({ kind: "ok", events: [text("ok"), stop()], model: "p2" })
    const llm = new FallbackLLM({ providers: [p1, p2], metrics: sink })
    await drain(llm.stream({} as never))
    // All emits have delta=1 (or undefined → defaulted in our spy to no delta;
    // we set delta explicitly in helper so undefined is meaningful).
    for (const e of sink.emits) {
      expect(e.delta).toBe(1)
    }
  })

  test("METRIC-14: attempt emits ONCE PER provider tried (index label monotone)", async () => {
    // 4 providers, last succeeds → 4 attempt emits with index 0..3.
    const sink = makeSink()
    const p1 = new ScriptedLLM({ kind: "throw", error: overload(), model: "p1" })
    const p2 = new ScriptedLLM({ kind: "throw", error: overload(), model: "p2" })
    const p3 = new ScriptedLLM({ kind: "throw", error: overload(), model: "p3" })
    const p4 = new ScriptedLLM({ kind: "ok", events: [text("ok"), stop()], model: "p4" })
    const llm = new FallbackLLM({ providers: [p1, p2, p3, p4], metrics: sink })
    await drain(llm.stream({} as never))
    const attempts = sink.emits.filter((e) => e.name === FALLBACK_METRIC_NAMES.attempt)
    expect(attempts).toHaveLength(4)
    expect(attempts.map((a) => a.labels?.index)).toEqual(["0", "1", "2", "3"])
  })
})
