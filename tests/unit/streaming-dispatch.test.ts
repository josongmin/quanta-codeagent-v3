import { describe, expect, spyOn, test } from "bun:test"
import {
  type DispatchOutcome,
  type StreamingCall,
  streamingTurn,
  type ToolInputStreamSeam,
} from "@/agent/streaming-dispatch"
import { buildToolInputSeam } from "@/agent/tool-input-streaming"
import { assembleFromEvents, type StreamEvent } from "@/llm"
import { logger } from "@/shared"
import { defineTool, ToolRegistry } from "@/tool"
import { z } from "zod"

/** Async generator over a fixed event list. `onEmit` fires AFTER each event is
 *  yielded so a test can record interleaving (e.g. assert a dispatch started
 *  before the stream finished). */
async function* gen(
  events: StreamEvent[],
  onEmit?: (ev: StreamEvent, i: number) => void,
): AsyncGenerator<StreamEvent> {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i] as StreamEvent
    yield ev
    onEmit?.(ev, i)
    // Yield to the microtask queue so any in-flight dispatch scheduled by the
    // consumer can make progress between stream events (models the real gap).
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

/** A dispatch mock that records start/end ordering into `log`. `safe` decides
 *  which tool names are concurrency-safe. */
const makeHarness = (safeNames: string[], readOnlyNames: string[] = safeNames) => {
  const log: string[] = []
  const isConcurrencySafe = (name: string): boolean => safeNames.includes(name)
  // T02 M1 — the loop now gates early-start on read-only AND concurrency-safe.
  // The harness's "safe" tools (`read`) are also read-only, so by default the
  // read-only set mirrors `safeNames`, preserving the prior overlap intent.
  const isReadOnly = (name: string): boolean => readOnlyNames.includes(name)
  const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
    log.push(`start:${call.id}`)
    // A real (timer) gap so an early-started call is still in flight while the
    // stream keeps producing events / starting siblings — models true overlap.
    await new Promise((r) => setTimeout(r, 10))
    log.push(`end:${call.id}`)
    return block(call.id, `out-${call.id}`)
  }
  return { log, isConcurrencySafe, isReadOnly, dispatch }
}

describe("streamingTurn", () => {
  test("zero tools degrades byte-identical to assembleFromEvents", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const deltas: string[] = []
    const res = await streamingTurn({
      events: gen(events),
      isConcurrencySafe: () => true,
      dispatch: async () => block("x", "x"),
      onTextDelta: (d) => deltas.push(d),
    })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return
    const expected = assembleFromEvents(events)
    expect(res.message).toEqual(expected.message)
    expect(res.stopReason).toBe(expected.stopReason)
    expect(res.resultBlocks).toEqual([])
    expect(deltas).toEqual(["Hel", "lo"])
  })

  test("all-safe calls overlap: dispatch starts BEFORE the stream ends", async () => {
    const { log, isConcurrencySafe, isReadOnly, dispatch } = makeHarness(["read"])
    const events: StreamEvent[] = [
      ...toolUse("t1", "read", { p: "a" }),
      { type: "text_delta", delta: "thinking more..." },
      ...toolUse("t2", "read", { p: "b" }),
      { type: "text_delta", delta: "done" },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({
      events: gen(events, (ev) => log.push(`ev:${ev.type}`)),
      isConcurrencySafe,
      isReadOnly,
      dispatch,
    })
    expect(res.kind).toBe("assembled")
    // t1 must have STARTED before the stream's message_stop event was emitted.
    const t1Start = log.indexOf("start:t1")
    const msgStop = log.indexOf("ev:message_stop")
    expect(t1Start).toBeGreaterThanOrEqual(0)
    expect(t1Start).toBeLessThan(msgStop)
    // Both safe calls overlapped (both started before either ended).
    const s1 = log.indexOf("start:t1")
    const s2 = log.indexOf("start:t2")
    const e1 = log.indexOf("end:t1")
    expect(s2).toBeLessThan(e1)
    expect(s1).toBeLessThan(s2)
  })

  test("unsafe call is a head-of-line barrier (not started while stream open)", async () => {
    const { log, isConcurrencySafe, dispatch } = makeHarness(["read"])
    const events: StreamEvent[] = [
      ...toolUse("w1", "write", { p: "a" }),
      { type: "text_delta", delta: "more" },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    await streamingTurn({
      events: gen(events, (ev) => log.push(`ev:${ev.type}`)),
      isConcurrencySafe,
      dispatch,
    })
    // The unsafe write must NOT start until AFTER message_stop is seen.
    const w1Start = log.indexOf("start:w1")
    const msgStop = log.indexOf("ev:message_stop")
    expect(w1Start).toBeGreaterThan(msgStop)
  })

  test("safe call AFTER an unsafe barrier is deferred (no overlap)", async () => {
    const { log, isConcurrencySafe, dispatch } = makeHarness(["read"])
    const events: StreamEvent[] = [
      ...toolUse("w1", "write", { p: "a" }),
      ...toolUse("r1", "read", { p: "b" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    await streamingTurn({
      events: gen(events, (ev) => log.push(`ev:${ev.type}`)),
      isConcurrencySafe,
      dispatch,
    })
    const msgStop = log.indexOf("ev:message_stop")
    // Neither the barrier nor the trailing safe call starts during the stream;
    // and they run serially in order (w1 fully done before r1 starts).
    expect(log.indexOf("start:w1")).toBeGreaterThan(msgStop)
    expect(log.indexOf("start:r1")).toBeGreaterThan(msgStop)
    expect(log.indexOf("end:w1")).toBeLessThan(log.indexOf("start:r1"))
  })

  test("mixed order preserved in resultBlocks (model call order)", async () => {
    const { isConcurrencySafe, dispatch } = makeHarness(["read"])
    const events: StreamEvent[] = [
      ...toolUse("r1", "read", { p: "a" }),
      ...toolUse("w1", "write", { p: "b" }),
      ...toolUse("r2", "read", { p: "c" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return
    expect(res.resultBlocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))).toEqual([
      "r1",
      "w1",
      "r2",
    ])
  })

  test("stream_reset discards in-flight + returns only post-reset turn", async () => {
    const started: string[] = []
    const isConcurrencySafe = (): boolean => true
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => {
      started.push(call.id)
      return block(call.id, `out-${call.id}`)
    }
    const events: StreamEvent[] = [
      ...toolUse("dead1", "read", { p: "x" }),
      { type: "text_delta", delta: "garbage from dead provider" },
      { type: "stream_reset" },
      { type: "text_delta", delta: "fresh" },
      ...toolUse("live1", "read", { p: "y" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return
    // Only the post-reset message survives.
    expect(res.message.content).toEqual([
      { type: "text", text: "fresh", phase: "commentary" },
      { type: "tool_use", id: "live1", name: "read", input: { p: "y" } },
    ])
    expect(res.resultBlocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))).toEqual([
      "live1",
    ])
    // The dead partial's call may have started (speculative) but its result is
    // discarded; the surviving result set is post-reset only.
    expect(started).toContain("live1")
  })

  test("abort between phases yields {kind:'aborted'}", async () => {
    const ctrl = new AbortController()
    const isConcurrencySafe = (): boolean => false
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> => block(call.id, "x")
    const events: StreamEvent[] = [
      ...toolUse("w1", "write", { p: "a" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    // Abort as soon as the first event is emitted.
    const res = await streamingTurn({
      events: gen(events, () => ctrl.abort()),
      isConcurrencySafe,
      dispatch,
      signal: ctrl.signal,
    })
    expect(res.kind).toBe("aborted")
    // The mid-event `ctrl.abort()` flipped the signal — observable invariant.
    expect(ctrl.signal.aborted).toBe(true)
  })

  test("pre-aborted signal short-circuits to aborted", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await streamingTurn({
      events: gen([
        ...toolUse("r1", "read", {}),
        { type: "message_stop", stop_reason: "tool_use" },
      ]),
      isConcurrencySafe: () => true,
      dispatch: async (c) => block(c.id, "x"),
      signal: ctrl.signal,
    })
    expect(res.kind).toBe("aborted")
  })

  test("error tool_result is still ordered correctly", async () => {
    const isConcurrencySafe = (name: string): boolean => name === "read"
    const dispatch = async (call: StreamingCall): Promise<DispatchOutcome> =>
      call.id === "bad" ? block(call.id, "boom", true) : block(call.id, "ok")
    const events: StreamEvent[] = [
      ...toolUse("r1", "read", { p: "a" }),
      ...toolUse("bad", "write", { p: "b" }),
      ...toolUse("r2", "read", { p: "c" }),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({ events: gen(events), isConcurrencySafe, dispatch })
    expect(res.kind).toBe("assembled")
    if (res.kind !== "assembled") return
    expect(res.resultBlocks).toEqual([
      { type: "tool_result", tool_use_id: "r1", content: "ok" },
      { type: "tool_result", tool_use_id: "bad", content: "boom", is_error: true },
      { type: "tool_result", tool_use_id: "r2", content: "ok" },
    ])
  })

  test("onToolStart fires once per call", async () => {
    const { isConcurrencySafe, dispatch } = makeHarness(["read"])
    const starts: string[] = []
    const events: StreamEvent[] = [
      ...toolUse("r1", "read", {}),
      ...toolUse("w1", "write", {}),
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    await streamingTurn({
      events: gen(events),
      isConcurrencySafe,
      dispatch,
      onToolStart: (c) => starts.push(c.id),
    })
    expect(starts.sort()).toEqual(["r1", "w1"])
  })
})

// ALBB-20 #8 — a faulty tool-input callback was DOUBLE-swallowed (inner
// per-callback catch + outer fireToolInput catch) ⇒ invisible at BOTH layers.
// The fix keeps the defensive swallow (stream never poisoned) but surfaces ONE
// logger.warn at the OUTER seam. Red-on-injection: delete the warn ⇒ this fails.
describe("streamingTurn #8 tool-input callback observability", () => {
  test("a throwing onToolInput seam is surfaced ONCE via logger.warn but does not poison the stream", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    const throwingSeam: ToolInputStreamSeam = {
      start() {
        throw new Error("faulty callback boom")
      },
      delta() {},
      available() {},
    }
    const events: StreamEvent[] = [
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: {} },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({
      events: gen(events),
      isConcurrencySafe: () => false, // defer so no dispatch needed
      dispatch: async (c) => block(c.id, "ok"),
      onToolInput: throwingSeam,
    })
    // Stream processing survived (assembled, not crashed).
    expect(res.kind).toBe("assembled")
    // Observable exactly once, at the outer seam.
    const startWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("fireToolInput(start)"),
    )
    expect(startWarns.length).toBe(1)
    expect(String(startWarns[0]?.[0])).toContain("faulty callback boom")
    warn.mockRestore()
  })

  // Second layer: drive the REAL registry-bound seam (tool-input-streaming.ts)
  // so the inner-vs-outer double-swallow is exercised end-to-end. If the inner
  // per-callback swallow is re-added, the outer warn never fires ⇒ red.
  test("a throwing registry-tool onInputStart propagates to the OUTER seam warn (no inner swallow)", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    const faultyTool = defineTool({
      name: "faulty",
      description: "d",
      inputSchema: z.object({}).passthrough(),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      // biome-ignore lint/suspicious/useAwait: async generator contract
      execute: async function* () {},
      onInputStart: () => {
        throw new Error("inner-layer boom")
      },
    })
    const registry = new ToolRegistry([faultyTool])
    const seam = buildToolInputSeam(registry)
    const events: StreamEvent[] = [
      { type: "tool_use_start", id: "f1", name: "faulty" },
      { type: "tool_use_end", id: "f1", input: {} },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const res = await streamingTurn({
      events: gen(events),
      isConcurrencySafe: () => false,
      dispatch: async (c) => block(c.id, "ok"),
      onToolInput: seam,
    })
    expect(res.kind).toBe("assembled")
    const startWarns = warn.mock.calls.filter((c) => String(c[0]).includes("fireToolInput(start)"))
    expect(startWarns.length).toBe(1)
    expect(String(startWarns[0]?.[0])).toContain("inner-layer boom")
    warn.mockRestore()
  })
})
