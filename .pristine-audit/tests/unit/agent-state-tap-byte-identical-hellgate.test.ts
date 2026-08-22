/**
 * Hellgate — `wireAgentStateTap` byte-identical default-OFF + emit-sequence teeth.
 *
 * The agent-state stream tap (`@/agent/optional-ports#wireAgentStateTap`, reached
 * via `wireOptionalAgentPorts`) clones the item-lifecycle tap's posture: it
 * installs ONLY when `AgentConfig.onAgentState` is present (the web-daemon
 * comp-root sets that slot exclusively when `QUANTA_WEB_AGENT_STATE=1`). Absent
 * that slot ⇒ the stream is returned VERBATIM (the wrapper is never even
 * allocated) ⇒ byte-identical default-OFF.
 *
 * The load-bearing invariants pinned here (NOT import-identity — the proof is a
 * spy-count on the UNDERLYING stream so a wrapper that swallowed / reordered /
 * duplicated an emit would be caught):
 *
 *   1. No `onAgentState` ⇒ `wireOptionalAgentPorts` returns the SAME stream ref
 *      (tap is a no-op) AND every emit reaches the underlying spy in the exact
 *      same SEQUENCE as the undecorated stream (sequence equality).
 *   2. With `onAgentState` present ⇒ the stream IS wrapped, the underlying spy
 *      STILL sees every emit verbatim, in order, ONCE (the base emit fires first
 *      + unchanged — every existing consumer is byte-identical), AND the 9
 *      tapped types ALSO reach the sink.
 *   3. A NON-tapped event (e.g. `assistant_text`) reaches the spy but NOT the
 *      sink (the `AGENT_STATE_TYPES` filter gates the capture).
 */

import { describe, expect, test } from "bun:test"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { AgentStateObservation } from "@/protocol/agent-state"
import type { AgentEvent, StreamPort } from "@/stream"

/** Recording stream — every `emit` pushes onto `seen` (ordered). */
const capturingStream = (): { stream: StreamPort; seen: AgentEvent[] } => {
  const seen: AgentEvent[] = []
  return { stream: { emit: (e) => void seen.push(e) }, seen }
}

/** Minimal `AgentConfig` carrying just the fields `wireOptionalAgentPorts`
 *  needs. Optional `onAgentState` is the ONLY toggle that installs the tap. */
const baseWith = (
  stream: StreamPort,
  onAgentState?: { capture(ev: AgentStateObservation): void },
): AgentConfig =>
  ({
    llm: { model: "m" } as unknown as LLMPort,
    signal: new AbortController().signal,
    stream,
    ...(onAgentState !== undefined ? { onAgentState } : {}),
  }) as unknown as AgentConfig

/** A representative event for each of the 9 tapped types (used by the e2e
 *  sequence + the sink-capture assertions). */
const NINE_EVENTS: readonly AgentEvent[] = [
  { type: "plan_created", plan: { id: "p1", name: "P", version: 1, todos: [] } },
  { type: "plan_updated", delta: { kind: "plan_renamed", toName: "P2" }, version: 2 },
  { type: "plan_snapshot", plan: { id: "p1", name: "P2", version: 2, todos: [] } },
  { type: "plan_user_input_requested", promptId: "q1", prompt: "ok?" },
  { type: "plan_user_input_resolved", promptId: "q1", decision: "answer", text: "yes" },
  { type: "mode_changed", from: "default", to: "plan" },
  { type: "tool_progress", id: "t1", name: "shell", message: "running…" },
  {
    type: "context_compacted",
    fromTurnId: "a",
    toTurnId: "b",
    summary: "s",
    ts: 1,
    tokens: 10,
  },
  { type: "ratelimit_snapshot", observedAt: 5 },
] as AgentEvent[]

describe("wireAgentStateTap — default-OFF byte-identity (no onAgentState)", () => {
  test("no sink ⇒ stream returned UNWRAPPED (same reference)", () => {
    const { stream } = capturingStream()
    const out = wireOptionalAgentPorts(baseWith(stream), {})
    expect(out.stream).toBe(stream)
  })

  test("no sink ⇒ emit SEQUENCE on the underlying spy is identical to undecorated", () => {
    // TEETH: the proof is a per-emit spy count + ORDER on the underlying stream,
    // NOT `out.stream === stream` alone — a wrapper that dropped/reordered an
    // emit would be caught even if it (wrongly) returned the same ref.
    const decorated = capturingStream()
    const undecorated = capturingStream()
    const out = wireOptionalAgentPorts(baseWith(decorated.stream), {})

    for (const ev of NINE_EVENTS) {
      out.stream.emit(ev)
      undecorated.stream.emit(ev)
    }
    // Same length (no swallow / no duplicate) + same order + same identities.
    expect(decorated.seen).toHaveLength(NINE_EVENTS.length)
    expect(decorated.seen).toEqual(undecorated.seen)
    for (let i = 0; i < NINE_EVENTS.length; i++) {
      expect(decorated.seen[i]).toBe(NINE_EVENTS[i])
    }
  })
})

describe("wireAgentStateTap — gate ON (onAgentState present) decorates the stream", () => {
  test("base emit still reaches the spy verbatim + ONCE, AND the 9 reach the sink", () => {
    const { stream, seen } = capturingStream()
    const captured: AgentStateObservation[] = []
    const out = wireOptionalAgentPorts(
      baseWith(stream, { capture: (ev) => void captured.push(ev) }),
      {},
    )
    expect(out.stream).not.toBe(stream) // wrapped

    for (const ev of NINE_EVENTS) out.stream.emit(ev)

    // Every base emit reached the underlying spy, in order, exactly once.
    expect(seen).toHaveLength(NINE_EVENTS.length)
    for (let i = 0; i < NINE_EVENTS.length; i++) {
      expect(seen[i]).toBe(NINE_EVENTS[i])
    }
    // All 9 tapped types ALSO reached the sink (no silent drop). Compare the
    // discriminant tags as plain strings (the two arrays carry different literal
    // unions — `AgentStateObservation["type"]` vs `AgentEvent["type"]`).
    expect(captured.map((e) => e.type as string)).toEqual(NINE_EVENTS.map((e) => e.type as string))
  })

  test("a NON-tapped event reaches the spy but NOT the sink (AGENT_STATE_TYPES filter)", () => {
    const { stream, seen } = capturingStream()
    const captured: AgentStateObservation[] = []
    const out = wireOptionalAgentPorts(
      baseWith(stream, { capture: (ev) => void captured.push(ev) }),
      {},
    )
    const nonTapped = { type: "assistant_text", delta: "hello" } as AgentEvent
    out.stream.emit(nonTapped)
    expect(seen).toEqual([nonTapped]) // spy saw it
    expect(captured).toHaveLength(0) // sink did NOT
  })
})
