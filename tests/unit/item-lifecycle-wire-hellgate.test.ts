/**
 * Hellgate e2e — item-lifecycle ↔ wireOptionalAgentPorts wiring (GAP 10).
 *
 * The tracker logic is fuzz-proven in item-lifecycle-hellgate; this proves the
 * LIVE composition wire:
 *   - gate OFF ⇒ `config.stream` is returned UNWRAPPED (same ref) — byte-identical.
 *   - gate ON  ⇒ the stream is decorated so each emit ALSO emits the derived
 *     lifecycle events on the underlying sink (no re-entrancy, original event first).
 */
import { describe, expect, test } from "bun:test"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { AgentEvent, StreamPort } from "@/stream"

const capturingStream = (): { stream: StreamPort; seen: AgentEvent[] } => {
  const seen: AgentEvent[] = []
  return { stream: { emit: (e) => void seen.push(e) }, seen }
}

const baseWith = (stream: StreamPort): AgentConfig =>
  ({
    llm: { model: "m" } as unknown as LLMPort,
    signal: new AbortController().signal,
    stream,
  }) as unknown as AgentConfig

const toolCall = { type: "tool_call", id: "t1", name: "x", args: {} } as unknown as AgentEvent

describe("item-lifecycle wiring — default-OFF byte-identity", () => {
  test("gate unset ⇒ stream returned UNWRAPPED (same reference)", () => {
    const { stream } = capturingStream()
    const out = wireOptionalAgentPorts(baseWith(stream), {})
    expect(out.stream).toBe(stream)
  })
})

describe("item-lifecycle wiring — gate ON decorates the stream", () => {
  test("emit yields original event THEN its lifecycle events on the sink", () => {
    const { stream, seen } = capturingStream()
    const out = wireOptionalAgentPorts(baseWith(stream), { QUANTA_ITEM_LIFECYCLE: "1" })
    expect(out.stream).not.toBe(stream) // wrapped
    out.stream.emit(toolCall)
    // original tool_call first, then a derived item_started for it
    expect(seen[0]).toBe(toolCall)
    expect(seen.some((e) => e.type === "item_started")).toBe(true)
  })

  test("no re-entrancy: lifecycle events are not themselves re-tracked", () => {
    const { stream, seen } = capturingStream()
    const out = wireOptionalAgentPorts(baseWith(stream), { QUANTA_ITEM_LIFECYCLE: "1" })
    out.stream.emit(toolCall)
    // exactly one started (the tool_call), no started-of-a-started cascade
    expect(seen.filter((e) => e.type === "item_started")).toHaveLength(1)
  })
})
