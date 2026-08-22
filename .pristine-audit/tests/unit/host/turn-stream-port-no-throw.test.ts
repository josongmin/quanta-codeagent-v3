/**
 * ALBB-05 — `createTurnStreamPort.emit` NO-THROW base-emit parity (claim 1).
 *
 * Mirrors the proven `wireAgentStateTap` contract
 * (`tests/unit/agent-state-tap-byte-identical-hellgate.test.ts`): the BASE wire
 * (stdout / jsonl / every downstream consumer) is the source of truth and must
 * fire FIRST + verbatim + unconditionally. A throwing observer (the host
 * `onEvent` session bridge, or the item projector) must NEVER suppress the base
 * emit for that event, must never drop an event, and must never unwind into the
 * loop's emit call site.
 *
 * TEETH (red-on-injection): the proof is a fresh-readback spy count + ORDER on
 * the UNDERLYING base stream while an observer THROWS. This goes RED the instant
 * someone reintroduces base-emit-LAST or drops the fail-silent try/catch.
 */

import { describe, expect, test } from "bun:test"
import { createTurnStreamPort } from "@/host/runtime/internal/context-binding/turn-runner"
import type { SessionHostTurnEvent } from "@/kernel/session"
import type { AgentEvent, StreamPort } from "@/stream"
import { ItemStreamProjector } from "@/stream"

/** Recording base stream — every `emit` pushes onto `seen` (ordered). */
const capturingStream = (): { stream: StreamPort; seen: AgentEvent[] } => {
  const seen: AgentEvent[] = []
  return { stream: { emit: (e) => void seen.push(e) }, seen }
}

/** Events that DO project to a `SessionHostTurnEvent` (so `onEvent` fires) plus
 *  one `error` event (so `getLastErrorMessage` has something to reflect). */
const EVENTS: readonly AgentEvent[] = [
  { type: "assistant_text", delta: "hello" },
  { type: "usage", inputTokens: 3, outputTokens: 4 },
  { type: "error", message: "boom-1" },
  { type: "assistant_text", delta: "world" },
  { type: "error", message: "boom-final" },
] as AgentEvent[]

describe("createTurnStreamPort — throwing observer must NOT break the base emit", () => {
  test("(a) throwing onEvent ⇒ base spy STILL sees EVERY event, in order, ONCE", () => {
    const { stream, seen } = capturingStream()
    // onEvent throws on EVERY delivered session event — the most hostile sink.
    const port = createTurnStreamPort({
      baseStream: stream,
      onEvent: (_ev: SessionHostTurnEvent) => {
        throw new Error("hostile onEvent sink")
      },
    })

    // The emit itself must NOT unwind into the caller (the agent loop).
    for (const ev of EVENTS) {
      expect(() => port.stream.emit(ev)).not.toThrow()
    }

    // Base wire is byte-identical: every event, in order, exactly once.
    expect(seen).toHaveLength(EVENTS.length)
    for (let i = 0; i < EVENTS.length; i++) {
      expect(seen[i]).toBe(EVENTS[i])
    }
    // lastErrorMessage is captured synchronously BEFORE the guarded block.
    expect(port.getLastErrorMessage()).toBe("boom-final")
  })

  test("(a') throwing itemProjector.project ⇒ base spy STILL sees EVERY event, in order, ONCE", () => {
    const { stream, seen } = capturingStream()
    // DI-equivalent: force the internally-minted projector's `project` to throw.
    const original = ItemStreamProjector.prototype.project
    ItemStreamProjector.prototype.project = () => {
      throw new Error("hostile projector")
    }
    try {
      const port = createTurnStreamPort({
        baseStream: stream,
        onEvent: () => {}, // non-throwing; the projector is the hostile actor
        itemStream: true, // mints the projector
      })
      for (const ev of EVENTS) {
        expect(() => port.stream.emit(ev)).not.toThrow()
      }
      expect(seen).toHaveLength(EVENTS.length)
      for (let i = 0; i < EVENTS.length; i++) {
        expect(seen[i]).toBe(EVENTS[i])
      }
    } finally {
      ItemStreamProjector.prototype.project = original
    }
  })
})

describe("createTurnStreamPort — paired-control: non-throwing path is byte-identical", () => {
  test("(b) non-throwing onEvent ⇒ base passthrough byte-identical + error captured", () => {
    const decorated = capturingStream()
    const undecorated = capturingStream()
    const forwarded: SessionHostTurnEvent[] = []
    const port = createTurnStreamPort({
      baseStream: decorated.stream,
      onEvent: (ev) => void forwarded.push(ev),
    })

    for (const ev of EVENTS) {
      port.stream.emit(ev)
      undecorated.stream.emit(ev)
    }

    // Base wire is identical to the undecorated stream (no swallow / no dup / order).
    expect(decorated.seen).toHaveLength(EVENTS.length)
    expect(decorated.seen).toEqual(undecorated.seen)
    for (let i = 0; i < EVENTS.length; i++) {
      expect(decorated.seen[i]).toBe(EVENTS[i])
    }
    // Observer still saw the bridged events (onEvent fan-out unchanged).
    expect(forwarded.length).toBeGreaterThan(0)
    // Error capture preserved.
    expect(port.getLastErrorMessage()).toBe("boom-final")
  })
})

describe("createTurnStreamPort — base-FIRST ordering parity with wireAgentStateTap", () => {
  test("(c) base emit is observed BEFORE any onEvent fan-out (drift guard)", () => {
    // Structural parity teeth: record the interleaving of base-emit vs onEvent.
    const order: string[] = []
    const stream: StreamPort = { emit: () => void order.push("base") }
    const port = createTurnStreamPort({
      baseStream: stream,
      onEvent: () => void order.push("observer"),
    })
    // A single assistant_text emits base + one bridged session event.
    port.stream.emit({ type: "assistant_text", delta: "x" } as AgentEvent)
    expect(order[0]).toBe("base")
    expect(order).toContain("observer")
  })
})
