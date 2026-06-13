import { describe, expect, test } from "bun:test"
import { SESSION_HOST_TURN_EVENT_TYPES } from "../../../src/kernel/session"
import {
  AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES,
  AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_TYPES,
  toSessionHostTurnEvent,
} from "../../../src/host/runtime/internal/session-host-turn-event-bridge"
import { AGENT_EVENT_TYPES } from "../../../src/stream"

describe("session-host turn-event bridge inventory", () => {
  test("bridged AgentEvent set is explicit and stays a strict subset", () => {
    const canonical = new Set<string>(AGENT_EVENT_TYPES)
    for (const type of AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES) {
      expect(canonical.has(type)).toBe(true)
    }
    expect(AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES.length).toBe(7)
    expect(AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES.length).toBeLessThan(
      AGENT_EVENT_TYPES.length,
    )
  })

  test("bridge target set covers every SessionHostTurnEvent EXCEPT the projector-produced item.stream", () => {
    // T01 — `item.stream` is a SessionHostTurnEvent but is NOT produced by the
    // 1:1 AgentEvent bridge: the host's per-turn `ItemStreamProjector` emits it
    // DIRECTLY in `createTurnStreamPort` (stateful N:M, not a per-event map). So
    // the bridge targets are SessionHostTurnEvent MINUS `item.stream`.
    const bridge = new Set<string>(AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_TYPES)
    expect(bridge.has("item.stream")).toBe(false)
    expect([...AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_TYPES, "item.stream"].sort()).toEqual(
      [...SESSION_HOST_TURN_EVENT_TYPES].sort(),
    )
  })
})

describe("session-host turn-event bridge behavior", () => {
  test("empty assistant_text deltas are dropped before they hit the session host", () => {
    expect(toSessionHostTurnEvent({ type: "assistant_text", delta: "" })).toBeUndefined()
  })

  test("one representative bridged event materializes each canonical host event type", () => {
    const bridgedTypes = [
      toSessionHostTurnEvent({ type: "assistant_text", delta: "x" }),
      toSessionHostTurnEvent({ type: "llm_request", model: "gpt-5" }),
      toSessionHostTurnEvent({
        type: "llm_continuation",
        surfaceId: "openai-responses",
        transportId: "public",
        phase: "prepare",
        mode: "resume",
        reason: "prepared_resume",
      }),
      toSessionHostTurnEvent({ type: "tool_call", id: "c1", name: "bash", input: { cmd: "pwd" } }),
      toSessionHostTurnEvent({
        type: "tool_result",
        id: "c1",
        name: "bash",
        ok: true,
        preview: "pwd",
      }),
      toSessionHostTurnEvent({ type: "usage", inputTokens: 1, outputTokens: 2, model: "gpt-5" }),
      toSessionHostTurnEvent({
        type: "skill_scope_decision",
        id: "s1",
        tool: "bash",
        activeSkill: "rr",
        reason: "outside allowlist",
        isReadOnly: false,
        decision: "blocked",
      }),
    ]
      .map((event) => event?.type)
      .filter((type): type is string => type !== undefined)
      .sort()

    // The bridge materializes every host event type EXCEPT item.stream (produced
    // by the host's ItemStreamProjector, not this per-event map).
    expect(bridgedTypes).toEqual(
      [...SESSION_HOST_TURN_EVENT_TYPES].filter((t) => t !== "item.stream").sort(),
    )
  })
})
