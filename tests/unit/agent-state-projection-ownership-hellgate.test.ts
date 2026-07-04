import { describe, expect, test } from "bun:test"
import {
  AGENT_STATE_MESSAGE_KIND_BY_EVENT_TYPE,
  AGENT_STATE_OBSERVATION_EVENT_TYPES,
  AGENT_STATE_TYPES,
  agentStateObservationToMessage,
  projectAgentEventToAgentStateMessage,
  projectAgentEventToAgentStateObservation,
} from "@/protocol/agent-state"
import type { AgentEvent } from "@/stream"

const FIXTURES: { [K in (typeof AGENT_STATE_OBSERVATION_EVENT_TYPES)[number]]: AgentEvent } = {
  plan_created: { type: "plan_created", plan: { id: "p", name: "Plan", version: 1, todos: [] } },
  plan_updated: {
    type: "plan_updated",
    delta: { kind: "plan_renamed", toName: "Plan 2" },
    version: 2,
  },
  plan_snapshot: {
    type: "plan_snapshot",
    plan: { id: "p", name: "Plan 2", version: 2, todos: [] },
  },
  plan_user_input_requested: {
    type: "plan_user_input_requested",
    promptId: "prompt-1",
    prompt: "continue?",
  },
  plan_user_input_resolved: {
    type: "plan_user_input_resolved",
    promptId: "prompt-1",
    decision: "answer",
    text: "yes",
  },
  mode_changed: {
    type: "mode_changed",
    from: "default",
    to: "plan",
    fromAgentMode: "editor",
    toAgentMode: "plan",
    reason: "plan_enter_requested",
  },
  tool_progress: { type: "tool_progress", id: "tool-1", name: "edit", message: "running" },
  context_compacted: {
    type: "context_compacted",
    fromTurnId: "turn-1",
    toTurnId: "turn-2",
    summary: "summary",
    ts: 1,
    tokens: 3,
  },
  ratelimit_snapshot: { type: "ratelimit_snapshot", observedAt: 7 },
}

describe("agent-state projection ownership hellgate", () => {
  test("typed inventory and runtime set stay exact-match", () => {
    expect(Array.from(AGENT_STATE_TYPES)).toEqual([...AGENT_STATE_OBSERVATION_EVENT_TYPES])
  })

  test("every tapped event type has both observation and message ownership", () => {
    for (const type of AGENT_STATE_OBSERVATION_EVENT_TYPES) {
      const event = FIXTURES[type]
      const observation = projectAgentEventToAgentStateObservation(event)
      expect(observation?.type).toBe(type)

      const direct = projectAgentEventToAgentStateMessage(event)
      expect(direct?.kind).toBe(AGENT_STATE_MESSAGE_KIND_BY_EVENT_TYPE[type])

      const viaObservation =
        observation === null
          ? null
          : agentStateObservationToMessage(observation, { emittedAt: 123 })
      expect(viaObservation?.kind).toBe(AGENT_STATE_MESSAGE_KIND_BY_EVENT_TYPE[type])
      expect(viaObservation?.emittedAt).toBe(123)
      if (type === "mode_changed") {
        expect(direct).toMatchObject({
          kind: "mode.changed",
          fromAgentMode: "editor",
          toAgentMode: "plan",
          reason: "plan_enter_requested",
        })
        expect(viaObservation).toMatchObject({
          kind: "mode.changed",
          fromAgentMode: "editor",
          toAgentMode: "plan",
          reason: "plan_enter_requested",
        })
      }
    }
  })

  test("non-tapped events fail closed at the owner module", () => {
    const nonTapped: AgentEvent = { type: "assistant_text", delta: "hello" }
    expect(projectAgentEventToAgentStateObservation(nonTapped)).toBeNull()
    expect(projectAgentEventToAgentStateMessage(nonTapped)).toBeNull()
  })
})
