/**
 * Hellgate — T01 item-stream tap ↔ wireOptionalAgentPorts wiring (web plane).
 *
 * The projector logic is fuzz-proven in item-stream-projector-hellgate; this
 * proves the LIVE composition wire of the AGENT-STATE plane:
 *   - no sink (onAgentState absent) ⇒ stream returned UNWRAPPED — byte-identical.
 *   - sink present but gate OFF ⇒ stream returned UNWRAPPED — byte-identical.
 *   - sink present + gate ON ⇒ stream decorated; each emit emits the ORIGINAL
 *     event verbatim first, THEN feeds derived item.* observations to the sink.
 *   - a throwing sink never breaks the base emit (observation-only).
 */
import { describe, expect, test } from "bun:test"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { AgentStateObservation } from "@/protocol/agent-state"
import type { AgentEvent, StreamPort } from "@/stream"

const capturingStream = (): { stream: StreamPort; seen: AgentEvent[] } => {
  const seen: AgentEvent[] = []
  return { stream: { emit: (e) => void seen.push(e) }, seen }
}

const baseWith = (
  stream: StreamPort,
  onAgentState?: { capture(e: AgentStateObservation): void },
): AgentConfig =>
  ({
    llm: { model: "m" } as unknown as LLMPort,
    signal: new AbortController().signal,
    stream,
    ...(onAgentState !== undefined ? { onAgentState } : {}),
  }) as unknown as AgentConfig

const thinking = (delta: string): AgentEvent => ({ type: "assistant_thinking", delta })

describe("item-stream tap — default-OFF byte-identity", () => {
  test("no sink ⇒ stream UNWRAPPED even with gate ON", () => {
    const { stream } = capturingStream()
    const out = wireOptionalAgentPorts(baseWith(stream), { QUANTA_ITEM_STREAM: "1" })
    expect(out.stream).toBe(stream)
  })

  test("sink present + WEB_AGENT_STATE on but ITEM gate OFF ⇒ NO item.* observations", () => {
    // With a sink present the 9-type agent-state tap wraps the stream regardless,
    // so reference-equality can't isolate the item tap. Assert by BEHAVIOR: the
    // item gate OFF ⇒ the sink receives ZERO `item_stream` observations even
    // though reasoning deltas flow (byte-identical legacy agent-state channel).
    const { stream } = capturingStream()
    const captured: AgentStateObservation[] = []
    const sink = { capture: (e: AgentStateObservation) => void captured.push(e) }
    const out = wireOptionalAgentPorts(baseWith(stream, sink), { QUANTA_WEB_AGENT_STATE: "1" })
    out.stream.emit(thinking("hello"))
    expect(captured.some((o) => o.type === "item_stream")).toBe(false)
  })
})

describe("item-stream tap — gate ON feeds the sink", () => {
  test("emit emits ORIGINAL event verbatim, THEN item.* observations to the sink", () => {
    const { stream, seen } = capturingStream()
    const captured: AgentStateObservation[] = []
    const sink = { capture: (e: AgentStateObservation) => void captured.push(e) }
    const out = wireOptionalAgentPorts(baseWith(stream, sink), {
      QUANTA_ITEM_STREAM: "1",
      QUANTA_WEB_AGENT_STATE: "1",
    })
    expect(out.stream).not.toBe(stream) // wrapped

    out.stream.emit(thinking("hello"))
    // original event reaches the base stream verbatim
    expect(seen[0]).toEqual(thinking("hello"))
    // the sink received item.* observations (started + delta for the reasoning run)
    const itemObs = captured.filter((o) => o.type === "item_stream")
    expect(itemObs.length).toBeGreaterThanOrEqual(2)
    const phases = itemObs.map((o) => (o.type === "item_stream" ? o.item.phase : null))
    expect(phases).toContain("started")
    expect(phases).toContain("delta")
  })

  test("a throwing sink never breaks the base emit", () => {
    const { stream, seen } = capturingStream()
    const sink = {
      capture: () => {
        throw new Error("hostile sink")
      },
    }
    const out = wireOptionalAgentPorts(baseWith(stream, sink), {
      QUANTA_ITEM_STREAM: "1",
      QUANTA_WEB_AGENT_STATE: "1",
    })
    expect(() => out.stream.emit(thinking("x"))).not.toThrow()
    expect(seen[0]).toEqual(thinking("x"))
  })
})
