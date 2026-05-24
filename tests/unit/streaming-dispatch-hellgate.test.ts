/**
 * ★ CONTRACT — A4: src/agent/streaming-dispatch.ts HOL barrier (state.
 *   barrierEngaged on first concurrency-UNSAFE tool) + Slot.order preserves
 *   model-call order in resultBlocks. Trailing-safe-after-unsafe = serialized.
 *
 * A4 — streaming HEAD-OF-LINE barrier ADVERSARIAL hell-gate.
 *
 * Drives the pure `streamingTurn` engine (src/agent/streaming-dispatch.ts) with
 * scripted async-generator streams + a recording dispatch mock, and pins the
 * hard ordering/barrier invariants under adversarial tool sequences.
 *
 * Engine contract (file header of streaming-dispatch.ts):
 *   - concurrency-safe call with NO barrier yet ⇒ dispatched IN FLIGHT (overlaps
 *     the rest of the model stream).
 *   - first concurrency-UNSAFE call ⇒ HEAD-OF-LINE barrier: it and EVERY call
 *     after it (safe or not) are deferred and run STRICTLY SERIALLY in
 *     model-call order after the stream closes.
 *   - `resultBlocks` are ALWAYS in original model-call order, regardless of
 *     completion timing.
 *   - abort between phases ⇒ {kind:"aborted"}, no further dispatch starts.
 */
import { describe, expect, test } from "bun:test"
import { type DispatchOutcome, type StreamingCall, streamingTurn } from "@/agent/streaming-dispatch"
import type { StreamEvent } from "@/llm"

/** Async generator over a fixed event list; `onEmit` fires AFTER each event so
 *  a test can observe interleaving (e.g. a dispatch starting before stream
 *  close). A microtask yield after each event lets in-flight dispatch progress
 *  — models the real stream/dispatch overlap gap. */
async function* gen(
  events: StreamEvent[],
  onEmit?: (ev: StreamEvent, i: number) => void,
): AsyncGenerator<StreamEvent> {
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as StreamEvent
    yield e
    onEmit?.(e, i)
    await Promise.resolve()
  }
}

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
]

const block = (id: string, content: string, isError = false): DispatchOutcome => ({
  block: {
    type: "tool_result",
    tool_use_id: id,
    content,
    ...(isError ? { is_error: true } : {}),
  },
  ok: !isError,
  preview: content,
})

/** Dispatch mock that records start/end ordering into `log` and adds a real
 *  timer gap so an early-started call is verifiably in flight while the stream
 *  keeps producing events / starting siblings. `safeNames` decide concurrency
 *  safety (everything else is a barrier). */
const makeHarness = (safeNames: string[], gapMs = 10) => {
  const log: string[] = []
  const inFlight: Set<string> = new Set()
  let maxConcurrent = 0
  const isConcurrencySafe = (name: string): boolean => safeNames.includes(name)
  const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
    log.push(`start:${call.id}`)
    inFlight.add(call.id)
    maxConcurrent = Math.max(maxConcurrent, inFlight.size)
    await new Promise((r) => setTimeout(r, gapMs))
    inFlight.delete(call.id)
    log.push(`end:${call.id}`)
    return block(call.id, `out-${call.id}`)
  }
  return { log, isConcurrencySafe, dispatch, peakConcurrency: () => maxConcurrent }
}

const ids = (blocks: DispatchOutcome["block"][]): string[] =>
  blocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))

// ─────────────────────────────────────────────────────────────────────────
// 1. safe, safe, UNSAFE, safe, safe — the canonical adversarial interleave
// ─────────────────────────────────────────────────────────────────────────

describe("A4 — [s1,s2,u1,s3,s4]: leading safe overlap, barrier, trailing serial", () => {
  test("the two leading safe tools start IN FLIGHT (before stream close); both trailing safe defer", async () => {
    const { log, isConcurrencySafe, dispatch, peakConcurrency } = makeHarness(["read"])
    const events: StreamEvent[] = [
      ...toolUse("s1", "read", { p: 1 }),
      ...toolUse("s2", "read", { p: 2 }),
      ...toolUse("u1", "write", { p: 3 }), // barrier
      ...toolUse("s3", "read", { p: 4 }), // deferred (behind barrier)
      ...toolUse("s4", "read", { p: 5 }), // deferred (behind barrier)
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({
      events: gen(events, (e) => log.push(`ev:${e.type}`)),
      isConcurrencySafe,
      dispatch,
    })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return

    const msgStop = log.indexOf("ev:message_stop")
    // s1 and s2 started DURING the stream (before message_stop) — overlap win.
    expect(log.indexOf("start:s1")).toBeGreaterThanOrEqual(0)
    expect(log.indexOf("start:s1")).toBeLessThan(msgStop)
    expect(log.indexOf("start:s2")).toBeLessThan(msgStop)
    // The two leading safe calls actually overlapped (both in flight together).
    expect(peakConcurrency()).toBeGreaterThanOrEqual(2)

    // u1 (barrier) and BOTH trailing safe calls must NOT start during the stream.
    expect(log.indexOf("start:u1")).toBeGreaterThan(msgStop)
    expect(log.indexOf("start:s3")).toBeGreaterThan(msgStop)
    expect(log.indexOf("start:s4")).toBeGreaterThan(msgStop)

    // The deferred trio runs STRICTLY SERIALLY in model order: u1 ends before
    // s3 starts; s3 ends before s4 starts (no overlap among deferred work).
    expect(log.indexOf("end:u1")).toBeLessThan(log.indexOf("start:s3"))
    expect(log.indexOf("end:s3")).toBeLessThan(log.indexOf("start:s4"))
  })

  test("resultBlocks are in EXACT model-call order [s1,s2,u1,s3,s4]", async () => {
    const { isConcurrencySafe, dispatch } = makeHarness(["read"])
    const events: StreamEvent[] = [
      ...toolUse("s1", "read", { p: 1 }),
      ...toolUse("s2", "read", { p: 2 }),
      ...toolUse("u1", "write", { p: 3 }),
      ...toolUse("s3", "read", { p: 4 }),
      ...toolUse("s4", "read", { p: 5 }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return
    expect(ids(res.resultBlocks)).toEqual(["s1", "s2", "u1", "s3", "s4"])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Two unsafe back-to-back — strict serialization, order preserved
// ─────────────────────────────────────────────────────────────────────────

describe("A4 — two unsafe back-to-back", () => {
  test("strict serialization (no overlap) and model order preserved", async () => {
    const { log, isConcurrencySafe, dispatch, peakConcurrency } = makeHarness(["read"])
    const events: StreamEvent[] = [
      ...toolUse("w1", "write", { p: 1 }),
      ...toolUse("w2", "write", { p: 2 }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({
      events: gen(events, (e) => log.push(`ev:${e.type}`)),
      isConcurrencySafe,
      dispatch,
    })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return
    const msgStop = log.indexOf("ev:message_stop")
    // Neither starts during the stream.
    expect(log.indexOf("start:w1")).toBeGreaterThan(msgStop)
    expect(log.indexOf("start:w2")).toBeGreaterThan(msgStop)
    // Strict serial: w1 fully done before w2 begins; never concurrent.
    expect(log.indexOf("end:w1")).toBeLessThan(log.indexOf("start:w2"))
    expect(peakConcurrency()).toBe(1)
    expect(ids(res.resultBlocks)).toEqual(["w1", "w2"])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. Abort mid-barrier — after unsafe dispatched, before trailing drain
// ─────────────────────────────────────────────────────────────────────────

describe("A4 — abort fired mid-barrier", () => {
  test("no deferred tool starts after abort; turn finishes cleanly (no hang, no orphan)", async () => {
    const ctrl = new AbortController()
    const started: string[] = []
    const isConcurrencySafe = (name: string): boolean => name === "read"
    // The FIRST deferred dispatch (the barrier call) aborts as a side effect
    // the instant it starts — so the drain loop's next iteration must see the
    // abort and NOT start any further deferred tool.
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      started.push(call.id)
      if (call.name === "write") ctrl.abort()
      return block(call.id, `out-${call.id}`)
    }
    const events: StreamEvent[] = [
      ...toolUse("u1", "write", { p: 1 }), // barrier — aborts when it runs
      ...toolUse("d2", "read", { p: 2 }), // deferred behind barrier
      ...toolUse("d3", "read", { p: 3 }), // deferred behind barrier
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await withTimeoutTurn(
      streamingTurn({ events: gen(events), isConcurrencySafe, dispatch, signal: ctrl.signal }),
    )
    // The drain detects the abort between deferred dispatches → aborted result.
    expect(res.kind).toBe("aborted")
    // No deferred tool AFTER the barrier started once the abort fired.
    expect(started).not.toContain("d2")
    expect(started).not.toContain("d3")
    // The barrier's side-effect `ctrl.abort()` flipped the signal.
    expect(ctrl.signal.aborted).toBe(true)
  })

  test("pre-aborted signal mid-barrier sequence short-circuits to aborted with zero dispatch", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const started: string[] = []
    const events: StreamEvent[] = [
      ...toolUse("u1", "write", {}),
      ...toolUse("d2", "read", {}),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({
      events: gen(events),
      isConcurrencySafe: (n) => n === "read",
      dispatch: async (c) => {
        started.push(c.id)
        return block(c.id, "x")
      },
      signal: ctrl.signal,
    })
    expect(res.kind).toBe("aborted")
    expect(started).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. All-unsafe sequence — fully serial, order preserved
// ─────────────────────────────────────────────────────────────────────────

describe("A4 — all-unsafe sequence", () => {
  test("fully serial (peak concurrency 1) with model order preserved", async () => {
    const { log, isConcurrencySafe, dispatch, peakConcurrency } = makeHarness([]) // nothing safe
    const events: StreamEvent[] = [
      ...toolUse("w1", "write", { p: 1 }),
      ...toolUse("w2", "write", { p: 2 }),
      ...toolUse("w3", "write", { p: 3 }),
      ...toolUse("w4", "write", { p: 4 }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({
      events: gen(events, (e) => log.push(`ev:${e.type}`)),
      isConcurrencySafe,
      dispatch,
    })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return
    const msgStop = log.indexOf("ev:message_stop")
    // None start during the stream; each ends before the next starts.
    for (const w of ["w1", "w2", "w3", "w4"]) {
      expect(log.indexOf(`start:${w}`)).toBeGreaterThan(msgStop)
    }
    expect(log.indexOf("end:w1")).toBeLessThan(log.indexOf("start:w2"))
    expect(log.indexOf("end:w2")).toBeLessThan(log.indexOf("start:w3"))
    expect(log.indexOf("end:w3")).toBeLessThan(log.indexOf("start:w4"))
    expect(peakConcurrency()).toBe(1)
    expect(ids(res.resultBlocks)).toEqual(["w1", "w2", "w3", "w4"])
  })
})

/** Race a streamingTurn against a hang guard — a barrier/abort bug that hangs
 *  the drain would otherwise stall the whole suite. */
async function withTimeoutTurn<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("HANG: streamingTurn did not terminate")), 10_000)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
