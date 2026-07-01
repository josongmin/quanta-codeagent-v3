import { describe, expect, it } from "bun:test"
import type { StreamEvent } from "@/llm"
import {
  type DispatchOutcome,
  type StreamingCall,
  type StreamingTurnArgs,
  streamingTurn,
} from "./streaming-dispatch"

/**
 * FIX 6 — early-dispatch abort hole for `agent`.
 *
 * `agent` is the one NON-read-only tool historically allowed early dispatch
 * (`isEarlyDispatchSafe:true`). Its `dispatch(call)` is fired IN FLIGHT (not
 * awaited). On `config.signal` abort the stream loop hits an abort check →
 * `abandonInFlight` (fire-and-forget `.catch`, discards the in-flight promise)
 * → returns `{kind:"aborted"}` BEFORE the early slot's `tool_result` is
 * appended. If the child `agent` already committed a side effect (write/bash)
 * before observing the shared signal, that mutation persists but its
 * `tool_result` is never recorded → on resume the transcript has no record it
 * ran → double-exec risk.
 *
 * The consumer (`loop/stream-consume.ts`) treats `{kind:"aborted"}` as a
 * terminal discard (it never reads `resultBlocks` on that branch, and
 * appending them there would require an out-of-fence change to
 * `stream-consume.ts` + `loop/types.ts`). So the fence-clean, hole-closing fix
 * is option (b): restrict early dispatch to STRICTLY read-only tools — drop the
 * `agent` exception — so a NON-read-only tool is NEVER early-started and can
 * never commit a side effect whose result is then silently discarded on abort.
 * `agent` still runs, just in the Phase-3 serial drain (byte-identical
 * `resultBlocks`/ordering; only wall-clock overlap timing changes).
 */

const toolUse = (id: string, name: string): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input: {} },
]

async function* fromEvents(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const ev of events) yield ev
}

/** A stream that yields the given prefix, then (if `abortAt` provided) trips
 *  the signal and yields one more event so the in-loop abort check fires on the
 *  NEXT iteration — this is exactly the mid-stream abort short-circuit path. */
async function* fromEventsThenAbort(
  prefix: StreamEvent[],
  controller: AbortController,
  tail: StreamEvent[],
): AsyncIterable<StreamEvent> {
  for (const ev of prefix) yield ev
  controller.abort()
  for (const ev of tail) yield ev
}

const okOutcome = (call: StreamingCall): DispatchOutcome => ({
  block: {
    type: "tool_result",
    tool_use_id: call.id,
    content: `ran:${call.name}`,
    is_error: false,
  },
  ok: true,
  preview: `ran:${call.name}`,
})

interface Recorder {
  dispatched: string[]
  args: StreamingTurnArgs
}

/** Build args where `read` is read-only+concurrency-safe and `agent` is
 *  NON-read-only but opts into early dispatch via `isEarlyDispatchSafe`. */
const makeArgs = (
  events: AsyncIterable<StreamEvent>,
  overrides: Partial<StreamingTurnArgs> = {},
): Recorder => {
  const dispatched: string[] = []
  const args: StreamingTurnArgs = {
    events,
    isConcurrencySafe: () => true,
    isReadOnly: (name) => name === "read",
    isEarlyDispatchSafe: (name) => name === "read" || name === "agent",
    dispatch: async (call) => {
      dispatched.push(call.name)
      return okOutcome(call)
    },
    ...overrides,
  }
  return { dispatched, args }
}

describe("streamingTurn — FIX 6 early-dispatch abort hole for `agent`", () => {
  it("does NOT early-dispatch a non-read-only `agent` before a mid-stream abort (no lost committed side-effect)", async () => {
    const controller = new AbortController()
    // agent's tool_use_end is fully streamed, THEN the signal trips, THEN one
    // more event arrives so the for-await abort check fires. If `agent` were
    // early-dispatched (the bug), its dispatch would already have been fired
    // in flight and then silently discarded by abandonInFlight — a committed
    // side-effect with no recorded tool_result.
    const events = fromEventsThenAbort(toolUse("a1", "agent"), controller, [
      { type: "text_delta", delta: "x" },
    ])
    const rec = makeArgs(events, { signal: controller.signal })

    const result = await streamingTurn(rec.args)

    expect(result.kind).toBe("aborted")
    // The hole: with the bug, `agent` WAS dispatched in flight (committed) and
    // then discarded → dispatched would contain "agent". The fix keeps agent
    // OUT of early dispatch, so nothing ran → no unrecorded committed effect.
    expect(rec.dispatched).not.toContain("agent")
    expect(rec.dispatched).toEqual([])
  })

  it("STILL early-dispatches a read-only tool (read-only early-dispatch behavior unchanged)", async () => {
    // No abort: a read-only `read` must early-start in flight, exactly as before.
    // Observe that `read` is dispatched WHILE the stream is still open (i.e.
    // in flight), by tripping a latch on dispatch and checking it before the
    // trailing text delta is consumed. We interleave a probe: `read`'s
    // dispatch must fire before the tail event is observed.
    let readDispatchedBeforeTail = false
    let tailSeen = false
    async function* streamWithTailProbe(): AsyncIterable<StreamEvent> {
      yield { type: "tool_use_start", id: "r1", name: "read" }
      yield { type: "tool_use_end", id: "r1", input: {} }
      // If `read` early-started, its dispatch (a resolved microtask push) will
      // have run by the time control returns to this generator on the next
      // `for await` pump — assert the ordering below via the recorded array.
      yield { type: "text_delta", delta: "tail" }
      tailSeen = true
    }
    const dispatched: string[] = []
    const args: StreamingTurnArgs = {
      events: streamWithTailProbe(),
      isConcurrencySafe: () => true,
      isReadOnly: (name) => name === "read",
      isEarlyDispatchSafe: (name) => name === "read" || name === "agent",
      dispatch: async (call) => {
        dispatched.push(call.name)
        if (call.name === "read" && !tailSeen) readDispatchedBeforeTail = true
        return okOutcome(call)
      },
    }
    const result = await streamingTurn(args)
    expect(result.kind).toBe("assembled")
    // Read-only early-dispatch invariant: `read` fired in flight (before the
    // trailing text delta was fully consumed), byte-identical to pre-fix.
    expect(readDispatchedBeforeTail).toBe(true)
    expect(dispatched).toContain("read")
  })

  it("HAPPY PATH (no abort): result-block order == model-call order for mixed read/agent", async () => {
    // read (early, in-flight) + agent (now deferred) + read2 (early). Regardless
    // of scheduling, resultBlocks MUST be in model-call order r1, a1, r2.
    const events = fromEvents([
      ...toolUse("r1", "read"),
      ...toolUse("a1", "agent"),
      ...toolUse("r2", "read"),
      { type: "text_delta", delta: "done" },
    ])
    const rec = makeArgs(events)
    const result = await streamingTurn(rec.args)
    expect(result.kind).toBe("assembled")
    if (result.kind !== "assembled") return
    const ids = result.resultBlocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : "?"))
    expect(ids).toEqual(["r1", "a1", "r2"])
    // All three ran exactly once.
    expect(rec.dispatched.sort()).toEqual(["agent", "read", "read"])
  })

  it("HAPPY PATH: `agent` still runs (in the serial drain) and produces its result block", async () => {
    const events = fromEvents([...toolUse("a1", "agent"), { type: "text_delta", delta: "z" }])
    const rec = makeArgs(events)
    const result = await streamingTurn(rec.args)
    expect(result.kind).toBe("assembled")
    if (result.kind !== "assembled") return
    expect(rec.dispatched).toEqual(["agent"])
    expect(result.resultBlocks).toHaveLength(1)
    const block = result.resultBlocks[0]
    expect(block?.type === "tool_result" && block.tool_use_id).toBe("a1")
  })

  // G2 (hellaudit) — the HAPPY-PATH ordering tests above hold on BOTH pre- and
  // post-fix code (Phase-4 sorts by slot order regardless of early/deferred), so
  // they do not DISCRIMINATE the fix. This one does: it directly observes that
  // `agent` is dispatched at DRAIN time (after the stream closes), NOT in flight.
  it("DISCRIMINATOR: `agent` is dispatched at drain, NOT in flight (deferred, not early)", async () => {
    let agentDispatchedBeforeTail = false
    let tailSeen = false
    async function* streamWithTailProbe(): AsyncIterable<StreamEvent> {
      yield { type: "tool_use_start", id: "a1", name: "agent" }
      yield { type: "tool_use_end", id: "a1", input: {} }
      yield { type: "text_delta", delta: "tail" }
      tailSeen = true
    }
    const dispatched: string[] = []
    const args: StreamingTurnArgs = {
      events: streamWithTailProbe(),
      isConcurrencySafe: () => true,
      isReadOnly: (name) => name === "read",
      isEarlyDispatchSafe: (name) => name === "read" || name === "agent",
      dispatch: async (call) => {
        dispatched.push(call.name)
        if (call.name === "agent" && !tailSeen) agentDispatchedBeforeTail = true
        return okOutcome(call)
      },
    }
    const result = await streamingTurn(args)
    expect(result.kind).toBe("assembled")
    // On PRE-fix code `agent` early-started → agentDispatchedBeforeTail === true.
    // The fix defers it to the serial drain → it fires only AFTER tailSeen.
    expect(agentDispatchedBeforeTail).toBe(false)
    expect(dispatched).toContain("agent")
  })

  // G1 (hellaudit) — fail-safe: the early-gate is `isReadOnly?.(name) ?? false`,
  // so if `isReadOnly` is ever UNWIRED (the arg is optional) early dispatch turns
  // OFF entirely — correctness-preserving (everything defers), perf-only. This
  // pins that deliberate behavior so a future refactor that drops the wire is a
  // visible, intended perf change rather than a silent regression.
  it("FAIL-SAFE: `isReadOnly` unwired ⇒ NO tool early-dispatches (all deferred to drain)", async () => {
    let readDispatchedBeforeTail = false
    let tailSeen = false
    async function* streamWithTailProbe(): AsyncIterable<StreamEvent> {
      yield { type: "tool_use_start", id: "r1", name: "read" }
      yield { type: "tool_use_end", id: "r1", input: {} }
      yield { type: "text_delta", delta: "tail" }
      tailSeen = true
    }
    const dispatched: string[] = []
    const args: StreamingTurnArgs = {
      events: streamWithTailProbe(),
      isConcurrencySafe: () => true,
      // isReadOnly intentionally OMITTED (unwired).
      isEarlyDispatchSafe: () => true,
      dispatch: async (call) => {
        dispatched.push(call.name)
        if (call.name === "read" && !tailSeen) readDispatchedBeforeTail = true
        return okOutcome(call)
      },
    }
    const result = await streamingTurn(args)
    expect(result.kind).toBe("assembled")
    expect(readDispatchedBeforeTail).toBe(false) // nothing early-started
    expect(dispatched).toContain("read") // but everything still RUNS (at drain)
  })

  // G3 (hellaudit) — paired control for `abandonInFlight`: unlike `agent` (never
  // early-started, G-abort test above), a READ-ONLY tool IS early-started, and on
  // a mid-stream abort its in-flight dispatch is safely ABANDONED (read-only ⇒ no
  // committed side effect to lose). Proves the abort path abandons in-flight
  // read-only work without surfacing a late rejection.
  it("PAIRED CONTROL: an in-flight READ-ONLY early dispatch is abandoned on abort (no lost effect)", async () => {
    const controller = new AbortController()
    const events = fromEventsThenAbort(toolUse("r1", "read"), controller, [
      { type: "text_delta", delta: "x" },
    ])
    let readRejectedLate = false
    const dispatched: string[] = []
    const args: StreamingTurnArgs = {
      events,
      signal: controller.signal,
      isConcurrencySafe: () => true,
      isReadOnly: (name) => name === "read",
      isEarlyDispatchSafe: (name) => name === "read",
      // `read` early-starts in flight, then rejects AFTER the abort — the loop must
      // have already abandoned it (attached its own `.catch`) so this never becomes
      // an unhandled rejection and never lands in resultBlocks.
      dispatch: async (call) => {
        dispatched.push(call.name)
        await Promise.resolve()
        readRejectedLate = true
        throw new Error("late read rejection after abort")
      },
    }
    const result = await streamingTurn(args)
    expect(result.kind).toBe("aborted")
    // read DID early-start (paired contrast with `agent`, which never dispatches)
    expect(dispatched).toContain("read")
    // and its late rejection was absorbed by abandonInFlight (no throw escaped)
    await Promise.resolve()
    expect(readRejectedLate).toBe(true)
  })
})
