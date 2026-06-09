/**
 * Hellgate e2e — QUANTA_WEB_AGENT_STATE full daemon flow + NO-THROW injection.
 *
 * Drives the WHOLE out-of-band chain a real session exercises:
 *
 *     config.stream.emit(AgentEvent)                       (the loop's emit)
 *       └─ wireAgentStateTap                               (@/agent/optional-ports)
 *            └─ createAgentStateSource().sink.capture      (web-daemon source)
 *                 └─ attachAgentStateSink subscriber       (per-connection)
 *                      └─ agentEventToMessage + encode      (mapper + codec)
 *                           └─ ws.send(frame)               (the wire)
 *                                └─ decodeAgentStateFrame    (the client)
 *
 * Item 5 (adversarial e2e): with the sink wired (gate-ON posture), emit EACH of
 * the 9 `AgentEvent`s on `config.stream` and assert a decoded `AgentStateMessage`
 * of the MATCHING kind arrives at a fake WS client. This catches a silently
 * dropped event, a bad mapper rename (`tool_progress.id`→`toolCallId`), or a
 * codec-version drift — any of which would make the frontend render nothing.
 *
 * Item 6 (NO-THROW red-on-injection): a throwing sibling subscriber AND a dead
 * `ws.send` must NOT break the fan-out or the turn — the base stream already
 * emitted verbatim, and every fan-out point is try/catch-guarded. We inject both
 * failures and assert (a) the surviving connection still receives every frame
 * and (b) `config.stream.emit` never throws.
 */

import { describe, expect, test } from "bun:test"
import { createAgentStateSource } from "@/../src/apps/web-daemon/agent-state-source"
import { attachAgentStateSink } from "@/../src/apps/web-daemon/server"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import { type AgentStateMessage, decodeAgentStateFrame } from "@/protocol/agent-state"
import type { AgentEvent, StreamPort } from "@/stream"

/** A fake WS that records every `send`. Mirrors the daemon's `ObservabilitySendable`. */
const fakeWs = (): { send: (d: string | Uint8Array) => void; frames: string[] } => {
  const frames: string[] = []
  return { send: (d) => void frames.push(typeof d === "string" ? d : ""), frames }
}

const baseWith = (stream: StreamPort, onAgentState: { capture(ev: never): void }): AgentConfig =>
  ({
    llm: { model: "m" } as unknown as LLMPort,
    signal: new AbortController().signal,
    stream,
    onAgentState,
  }) as unknown as AgentConfig

/** The 9 source events + their expected wire kind (the mapper's output tag). */
const NINE: readonly { ev: AgentEvent; kind: AgentStateMessage["kind"] }[] = [
  {
    ev: { type: "plan_created", plan: { id: "p", name: "P", version: 1, todos: [] } },
    kind: "plan.created",
  },
  {
    ev: { type: "plan_updated", delta: { kind: "plan_renamed", toName: "P2" }, version: 2 },
    kind: "plan.updated",
  },
  {
    ev: { type: "plan_snapshot", plan: { id: "p", name: "P2", version: 2, todos: [] } },
    kind: "plan.snapshot",
  },
  {
    ev: { type: "plan_user_input_requested", promptId: "q", prompt: "ok?" },
    kind: "plan.input.requested",
  },
  {
    ev: { type: "plan_user_input_resolved", promptId: "q", decision: "answer", text: "y" },
    kind: "plan.input.resolved",
  },
  { ev: { type: "mode_changed", from: "default", to: "plan" }, kind: "mode.changed" },
  {
    ev: { type: "tool_progress", id: "t1", name: "shell", message: "go" },
    kind: "tool.progress",
  },
  {
    ev: {
      type: "context_compacted",
      fromTurnId: "a",
      toTurnId: "b",
      summary: "s",
      ts: 1,
      tokens: 9,
    },
    kind: "context.compacted",
  },
  { ev: { type: "ratelimit_snapshot", observedAt: 7 }, kind: "ratelimit.snapshot" },
] as { ev: AgentEvent; kind: AgentStateMessage["kind"] }[]

describe("QUANTA_WEB_AGENT_STATE e2e — every event reaches the client as the matching kind", () => {
  test("all 9 AgentEvents → decoded AgentStateMessage of the matching kind at a fake WS", () => {
    const source = createAgentStateSource()
    const ws = fakeWs()
    const attached = attachAgentStateSink(ws, { source })
    expect(attached).not.toBeNull()

    // Wire the live tap so emitting on config.stream feeds the source's sink.
    const underlying: AgentEvent[] = []
    const config = wireOptionalAgentPorts(
      baseWith({ emit: (e) => void underlying.push(e) }, source.sink),
      {},
    )

    for (const { ev } of NINE) config.stream.emit(ev)

    // The base stream saw every event verbatim (byte-identical in-band path).
    expect(underlying.map((e) => e.type)).toEqual(NINE.map((n) => n.ev.type))

    // The wire carried exactly 9 frames; each decodes to the matching kind.
    expect(ws.frames).toHaveLength(NINE.length)
    const decoded = ws.frames.map((f) => decodeAgentStateFrame(f))
    expect(decoded.every((m) => m !== null)).toBe(true)
    expect(decoded.map((m) => m?.kind)).toEqual(NINE.map((n) => n.kind))

    attached?.detach()
  })

  test("the mapper RENAME survives the wire: tool_progress.id → toolCallId / name → toolName", () => {
    const source = createAgentStateSource()
    const ws = fakeWs()
    attachAgentStateSink(ws, { source })
    source.sink.capture({ type: "tool_progress", id: "call-42", name: "edit", message: "x" })
    const msg = decodeAgentStateFrame(ws.frames[0])
    expect(msg?.kind).toBe("tool.progress")
    if (msg?.kind === "tool.progress") {
      expect(msg.toolCallId).toBe("call-42")
      expect(msg.toolName).toBe("edit")
    }
  })
})

describe("QUANTA_WEB_AGENT_STATE — NO-THROW red-on-injection (turn survives)", () => {
  test("a throwing sibling subscriber does NOT block the healthy connection or the turn", () => {
    const source = createAgentStateSource()

    // Inject a hostile subscriber FIRST (so it runs before the healthy one in
    // Set-insertion order) — it throws on every capture.
    source.subscribe(() => {
      throw new Error("hostile subscriber")
    })

    // A healthy connection attached AFTER it.
    const ws = fakeWs()
    attachAgentStateSink(ws, { source })

    const underlying: AgentEvent[] = []
    const config = wireOptionalAgentPorts(
      baseWith({ emit: (e) => void underlying.push(e) }, source.sink),
      {},
    )

    // The emit must not throw despite the hostile subscriber.
    expect(() => {
      for (const { ev } of NINE) config.stream.emit(ev)
    }).not.toThrow()

    // The turn continued: the base stream saw all 9 (byte-identical), and the
    // HEALTHY connection still received all 9 frames (sibling fault contained).
    expect(underlying).toHaveLength(NINE.length)
    expect(ws.frames).toHaveLength(NINE.length)
  })

  test("a DEAD ws.send (throws) does NOT break the source fan-out or the turn", () => {
    const source = createAgentStateSource()

    // A dead socket whose `send` always throws.
    const dead = {
      send: () => {
        throw new Error("EPIPE: socket closed")
      },
    }
    attachAgentStateSink(dead, { source })

    // A healthy connection sharing the same source.
    const healthy = fakeWs()
    attachAgentStateSink(healthy, { source })

    const underlying: AgentEvent[] = []
    const config = wireOptionalAgentPorts(
      baseWith({ emit: (e) => void underlying.push(e) }, source.sink),
      {},
    )

    expect(() => {
      for (const { ev } of NINE) config.stream.emit(ev)
    }).not.toThrow()

    // Dead socket's throw was swallowed; the turn + the healthy connection are
    // unaffected (all 9 frames delivered to the live socket).
    expect(underlying).toHaveLength(NINE.length)
    expect(healthy.frames).toHaveLength(NINE.length)
  })
})
