/**
 * Hellgate — T01 item-stream SESSION-WIRE plane end-to-end (createTurnStreamPort).
 *
 * Drives the EXACT production stream port the host installs per turn. Proves the
 * session-wire half of the dual-plane projection:
 *   - itemStream OFF ⇒ ONLY the 1:1 bridge events reach `onEvent`; NO item.stream
 *     carriers — byte-identical legacy.
 *   - itemStream ON  ⇒ each source AgentEvent yields its 1:1 bridge event FIRST
 *     (stable causal order), THEN 0..N item.stream carriers from the projector.
 *   - the base stream ALWAYS receives every original event verbatim (the loop's
 *     own consumers are untouched on both paths).
 *
 * `createTurnStreamPort` is the precise chokepoint `runRuntimeTurn` wires when
 * `base.itemStream === true` (resolved from `QUANTA_ITEM_STREAM` at
 * `wireRuntimePorts`), so this is the real wiring, not a re-implementation.
 */
import { describe, expect, test } from "bun:test"
import { __testing } from "@/host/runtime/internal/context-binding"
import type { SessionHostTurnEvent } from "@/kernel/session"
import type { AgentEvent } from "@/stream"

const { createTurnStreamPort } = __testing

const recordingBase = (): { stream: { emit(e: AgentEvent): void }; seen: AgentEvent[] } => {
  const seen: AgentEvent[] = []
  return { stream: { emit: (e: AgentEvent) => void seen.push(e) }, seen }
}

const thinking = (delta: string): AgentEvent => ({ type: "assistant_thinking", delta })
const toolCall = (id: string, name: string): AgentEvent =>
  ({ type: "tool_call", id, name, input: {} }) as AgentEvent
const done: AgentEvent = { type: "done", reason: "ok", turns: 1 }

describe("item-stream session-wire — gate OFF byte-identity", () => {
  test("itemStream absent ⇒ NO item.stream carriers, only the 1:1 bridge events", () => {
    const base = recordingBase()
    const onEvents: SessionHostTurnEvent[] = []
    const port = createTurnStreamPort({
      baseStream: base.stream as never,
      onEvent: (e) => void onEvents.push(e),
    })
    port.stream.emit(thinking("a")) // bridge drops thinking (not a 1:1 target)
    port.stream.emit(toolCall("t1", "bash")) // → tool.invoked
    port.stream.emit(done)

    expect(onEvents.some((e) => e.type === "item.stream")).toBe(false)
    // The tool_call still bridges to tool.invoked (legacy path intact).
    expect(onEvents.map((e) => e.type)).toEqual(["tool.invoked"])
    // base stream saw every original event verbatim.
    expect(base.seen.map((e) => e.type)).toEqual(["assistant_thinking", "tool_call", "done"])
  })
})

describe("item-stream session-wire — gate ON emits item.stream carriers", () => {
  test("a reasoning run yields item.stream started+delta; turn boundary flushes completed", () => {
    const base = recordingBase()
    const onEvents: SessionHostTurnEvent[] = []
    const port = createTurnStreamPort({
      baseStream: base.stream as never,
      onEvent: (e) => void onEvents.push(e),
      itemStream: true,
    })
    port.stream.emit(thinking("Let me "))
    port.stream.emit(thinking("think."))
    port.stream.emit(done)

    const items = onEvents.filter(
      (e): e is Extract<SessionHostTurnEvent, { type: "item.stream" }> => e.type === "item.stream",
    )
    expect(items.map((e) => e.item.phase)).toEqual(["started", "delta", "delta", "completed"])
    const completed = items.at(-1)?.item
    expect(completed).toMatchObject({
      phase: "completed",
      itemType: "reasoning",
      text: "Let me think.",
    })
    // base stream untouched: every original event verbatim.
    expect(base.seen.map((e) => e.type)).toEqual([
      "assistant_thinking",
      "assistant_thinking",
      "done",
    ])
  })

  test("for a tool_call, the 1:1 tool.invoked precedes the item.stream started (causal order)", () => {
    const base = recordingBase()
    const onEvents: SessionHostTurnEvent[] = []
    const port = createTurnStreamPort({
      baseStream: base.stream as never,
      onEvent: (e) => void onEvents.push(e),
      itemStream: true,
    })
    port.stream.emit(toolCall("t1", "bash"))
    const idxInvoked = onEvents.findIndex((e) => e.type === "tool.invoked")
    const idxItem = onEvents.findIndex((e) => e.type === "item.stream")
    expect(idxInvoked).toBeGreaterThanOrEqual(0)
    expect(idxItem).toBeGreaterThan(idxInvoked)
  })

  test("no onEvent consumer ⇒ no projector work, base stream still verbatim", () => {
    const base = recordingBase()
    // itemStream true but NO onEvent — the projector must not even be allocated;
    // emits must still pass through to base verbatim.
    const port = createTurnStreamPort({ baseStream: base.stream as never, itemStream: true })
    port.stream.emit(thinking("x"))
    expect(base.seen.map((e) => e.type)).toEqual(["assistant_thinking"])
  })
})
