/**
 * ★ CONTRACT — Track E (streaming-abort-catch): src/agent/streaming-dispatch.ts
 *   abort short-circuit must NOT leak an unhandledRejection from an early-started
 *   in-flight dispatch promise it abandons.
 *
 * On an abort short-circuit, `streamingTurn` returns `{kind:"aborted"}` and
 * walks away from every dispatch it already fired in flight (a concurrency-safe
 * read-only overlap call, OR an early-dispatch-safe `agent` spawn per ADR-0298 —
 * isolated child loop, not read-only). The abort has DECIDED to discard those
 * results. If such a promise LATER rejects (the spawned child throws on its own
 * abort; a tool rejects post-abort) with no handler attached, Bun/Node raises an
 * `unhandledRejection`.
 *
 * These hellgates prove `abandonInFlight(state)` attaches a noop `.catch` to
 * each STARTED slot at EVERY abort short-circuit so the late rejection is
 * suppressed — without swallowing any error a consumer still awaits (the abort
 * path returns before Phase 2/4 ever read these promises).
 *
 * ANTI-THEATER: against the unfixed code (no `abandonInFlight` call) the
 * early-started promise rejects with no handler ⇒ `process` emits
 * `unhandledRejection` ⇒ `seenUnhandled.length > 0` ⇒ these tests FAIL.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type DispatchOutcome, type StreamingCall, streamingTurn } from "@/agent/streaming-dispatch"
import type { StreamEvent } from "@/llm"

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
]

/** Async generator that yields events and AFTER a chosen index aborts the
 *  controller (so the abort lands between/within phases while a previously
 *  early-started dispatch is still pending). A microtask yield after each event
 *  lets the in-flight dispatch start before we abort. */
async function* genThenAbort(
  events: StreamEvent[],
  ctrl: AbortController,
  abortAfterIndex: number,
): AsyncGenerator<StreamEvent> {
  for (let i = 0; i < events.length; i++) {
    yield events[i] as StreamEvent
    await Promise.resolve()
    if (i === abortAfterIndex) ctrl.abort()
  }
}

/** Capture unhandledRejection events emitted DURING the test body. Installed in
 *  beforeEach so each test gets a clean slate; the rejected promise we plant
 *  must NOT show up here once the fix attaches its noop `.catch`. */
let seenUnhandled: unknown[] = []
let onUnhandled: ((reason: unknown) => void) | undefined

beforeEach(() => {
  seenUnhandled = []
  onUnhandled = (reason: unknown) => {
    seenUnhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
})

afterEach(() => {
  if (onUnhandled) process.off("unhandledRejection", onUnhandled)
  onUnhandled = undefined
})

/** Give the event loop a couple of macrotask turns so any pending rejected
 *  promise that escaped a handler would have surfaced as unhandledRejection by
 *  the time we assert. */
const settleRejections = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 30))
  await new Promise((r) => setTimeout(r, 0))
}

describe("Track E — abort abandons in-flight dispatch without unhandledRejection", () => {
  test("HELL-E-ABORT1: early-started dispatch rejects AFTER abort ⇒ aborted, no unhandledRejection", async () => {
    const ctrl = new AbortController()
    // `read` is concurrency-safe AND read-only ⇒ early-started in flight.
    const events: StreamEvent[] = [...toolUse("t1", "read", { p: 1 })]
    let rejectPlanted: (() => void) | undefined
    const dispatch = (_call: StreamingCall): Promise<DispatchOutcome> =>
      // A long-pending promise that we reject AFTER streamingTurn has already
      // short-circuited on abort and walked away from it.
      new Promise<DispatchOutcome>((_resolve, reject) => {
        rejectPlanted = () => reject(new Error("child aborted post-shortcircuit"))
      })

    const result = await streamingTurn({
      events: genThenAbort(events, ctrl, 1), // abort after the tool_use_end (slot started in flight)
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      dispatch,
      signal: ctrl.signal,
    })

    expect(result.kind).toBe("aborted")
    // Now fire the late rejection on the promise the abort abandoned.
    expect(rejectPlanted).toBeDefined()
    rejectPlanted?.()
    await settleRejections()

    expect(seenUnhandled).toEqual([])
  })

  test("HELL-E-ABORT2: early-dispatch-safe NON-read-only `agent` spawn (ADR-0298) rejecting after abort is abandoned cleanly", async () => {
    const ctrl = new AbortController()
    const events: StreamEvent[] = [...toolUse("a1", "agent", { task: "x" })]
    let rejectPlanted: (() => void) | undefined
    const dispatch = (_call: StreamingCall): Promise<DispatchOutcome> =>
      new Promise<DispatchOutcome>((_resolve, reject) => {
        rejectPlanted = () => reject(new Error("spawned child threw on its own abort"))
      })

    const result = await streamingTurn({
      events: genThenAbort(events, ctrl, 1),
      isConcurrencySafe: () => true,
      isReadOnly: () => false, // agent is NOT read-only
      isEarlyDispatchSafe: (name) => name === "agent", // ADR-0298 opt-in
      dispatch,
      signal: ctrl.signal,
    })

    expect(result.kind).toBe("aborted")
    rejectPlanted?.()
    await settleRejections()
    expect(seenUnhandled).toEqual([])
  })

  test("HELL-E-ABORT3: pre-aborted signal (abort before stream loop) — no started slot leaks", async () => {
    const ctrl = new AbortController()
    ctrl.abort() // already aborted before the for-await loop body runs
    const events: StreamEvent[] = [...toolUse("t1", "read", { p: 1 })]
    const dispatch = (_call: StreamingCall): Promise<DispatchOutcome> =>
      Promise.reject(new Error("must never be dispatched"))

    const result = await streamingTurn({
      events: genThenAbort(events, ctrl, 999),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      dispatch,
      signal: ctrl.signal,
    })

    await settleRejections()
    expect(result.kind).toBe("aborted")
    // Nothing was started (abort caught before handleStreamEvent), so no leak.
    expect(seenUnhandled).toEqual([])
  })

  test("HELL-E-ABORT4: control — non-aborted turn still surfaces a dispatch rejection as a dispatch-failed block (no over-swallow)", async () => {
    // Prove abandonInFlight does NOT swallow errors a consumer DOES await:
    // a normal (non-abort) turn whose early dispatch rejects must still produce
    // a synthetic dispatch-failed tool_result block in Phase 4.
    const events: StreamEvent[] = [...toolUse("t1", "read", { p: 1 })]
    const dispatch = (_call: StreamingCall): Promise<DispatchOutcome> =>
      Promise.reject(new Error("boom in dispatch"))

    async function* plain(evs: StreamEvent[]): AsyncGenerator<StreamEvent> {
      for (const e of evs) {
        yield e
        await Promise.resolve()
      }
    }

    const result = await streamingTurn({
      events: plain(events),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      dispatch,
      // no signal ⇒ never aborts
    })

    await settleRejections()
    expect(result.kind).toBe("assembled")
    if (result.kind !== "assembled") throw new Error("expected assembled")
    expect(result.resultBlocks.length).toBe(1)
    const b = result.resultBlocks[0]
    expect(b?.type).toBe("tool_result")
    if (b?.type === "tool_result") {
      expect(b.is_error).toBe(true)
      expect(String(b.content)).toContain("dispatch threw unexpectedly")
    }
    // The rejection was surfaced (not silently dropped) AND it did not escape as
    // an unhandledRejection.
    expect(seenUnhandled).toEqual([])
  })
})
