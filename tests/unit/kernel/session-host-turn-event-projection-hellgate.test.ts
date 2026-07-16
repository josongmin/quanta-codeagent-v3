import { describe, expect, test } from "bun:test"
import {
  createKernelSessionState,
  SESSION_HOST_TURN_EVENT_TYPES,
} from "../../../src/kernel/session"
import {
  projectSessionHostTurnEvent,
  SESSION_HOST_TURN_EVENT_PROJECTION_SOURCE_TYPES,
  SESSION_HOST_TURN_EVENT_PROJECTION_TARGET_TYPES,
} from "../../../src/kernel/session/session-host-turn-event-projection"
import { SESSION_EVENT_TYPES } from "../../../src/protocol/session"

const manifest = {
  approvals: "operator" as const,
  tools: true,
  memory: false,
  artifacts: true,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  serverAutoContinues: false,
  transport: "inproc" as const,
}

describe("session-host turn-event projection inventory", () => {
  test("projection source set covers SessionHostTurnEvent exactly", () => {
    expect([...SESSION_HOST_TURN_EVENT_PROJECTION_SOURCE_TYPES].sort()).toEqual(
      [...SESSION_HOST_TURN_EVENT_TYPES].sort(),
    )
  })

  test("projection target set is explicit and canonical", () => {
    const canonical = new Set<string>(SESSION_EVENT_TYPES)
    for (const type of SESSION_HOST_TURN_EVENT_PROJECTION_TARGET_TYPES) {
      expect(canonical.has(type)).toBe(true)
    }
    expect([...SESSION_HOST_TURN_EVENT_PROJECTION_TARGET_TYPES].sort()).toEqual([
      // UUX-1-12 (jul-10) — +4 additive observability targets (budget.breach /
      // context.compacted / tool.progress / turn.recovery).
      "budget.breach",
      "context.compacted",
      "item.completed",
      "item.delta",
      "item.started",
      "session.state.updated",
      "skill.scope.decision",
      "tool.completed",
      "tool.invoked",
      "tool.progress",
      "turn.llm.continuation",
      "turn.llm.request",
      "turn.output.delta",
      "turn.recovery",
    ])
  })
})

describe("session-host turn-event projection behavior", () => {
  test("one representative host event materializes each declared target event type", () => {
    const initialState = createKernelSessionState({
      sessionId: "projection-s1",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const projected = [
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:01.000Z",
        event: { type: "assistant_text.delta", delta: "po" },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:02.000Z",
        event: {
          type: "llm.request",
          model: "gpt-5",
          provider: "openai",
          surfaceId: "openai-responses",
          transportId: "public",
          authMode: "OpenAI BYOK",
        },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:03.000Z",
        event: {
          type: "llm.continuation",
          provider: "openai",
          surfaceId: "openai-responses",
          transportId: "public",
          phase: "prepare",
          mode: "resume",
          reason: "prepared_resume",
        },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:04.000Z",
        event: {
          type: "tool.invoked",
          toolCallId: "tool-1",
          toolName: "bash",
          argsPreview: '{"cmd":"pwd"}',
        },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:05.000Z",
        event: {
          type: "tool.completed",
          toolCallId: "tool-1",
          toolName: "bash",
          outcome: "ok",
          resultPreview: "/tmp",
          durationMs: 12,
        },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:06.000Z",
        event: {
          type: "skill.scope.decision",
          tool: "bash",
          activeSkill: "rr",
          decision: "blocked",
          isReadOnly: false,
        },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:07.000Z",
        event: {
          type: "usage",
          promptTokens: 3,
          completionTokens: 5,
          totalTokens: 8,
          costMicroUsd: 42,
        },
      }),
      // T01 — the item.stream carrier projects onto a phase-routed wire event.
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:08.000Z",
        event: {
          type: "item.stream",
          item: { phase: "started", itemId: "it-1", itemType: "reasoning", index: 0 },
        },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:09.000Z",
        event: {
          type: "item.stream",
          item: {
            phase: "delta",
            itemId: "it-1",
            itemType: "reasoning",
            deltaKind: "reasoning.text",
            delta: "hi",
          },
        },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:10.000Z",
        event: {
          type: "item.stream",
          item: { phase: "completed", itemId: "it-1", itemType: "reasoning", text: "hi" },
        },
      }),
      // UUX-1-12 — the additive observability quartet.
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:11.000Z",
        event: { type: "tool.progress", toolCallId: "tool-1", toolName: "bash", message: "run" },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:12.000Z",
        event: { type: "recovery", reason: "backoff" },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:13.000Z",
        event: {
          type: "context.compacted",
          fromTurnId: "t1",
          toTurnId: "t2",
          summary: "folded",
          ts: 1,
          tokens: 9,
        },
      }),
      projectSessionHostTurnEvent({
        state: initialState,
        commandId: "c1",
        emittedAt: "2026-06-12T00:00:14.000Z",
        event: {
          type: "budget.breach",
          severity: "soft",
          scope: "session-x",
          observed: 2,
          limit: 1,
        },
      }),
    ]

    expect(projected.map(({ emitted }) => emitted.type).sort()).toEqual(
      [...SESSION_HOST_TURN_EVENT_PROJECTION_TARGET_TYPES].sort(),
    )
  })

  test("usage updates kernel state and emits session.state.updated", () => {
    const initialState = createKernelSessionState({
      sessionId: "projection-s2",
      permissionMode: "default",
      capabilityManifest: manifest,
    })
    const projected = projectSessionHostTurnEvent({
      state: initialState,
      commandId: "c2",
      emittedAt: "2026-06-12T00:00:08.000Z",
      event: {
        type: "usage",
        promptTokens: 11,
        completionTokens: 13,
        totalTokens: 24,
        costMicroUsd: 99,
      },
    })

    expect(projected.emitted.type).toBe("session.state.updated")
    expect(projected.state.lastTokenUsage).toEqual({
      promptTokens: 11,
      completionTokens: 13,
      totalTokens: 24,
      costMicroUsd: 99,
    })
    expect(projected.state.revision).toBe(initialState.revision + 1)
    expect(projected.state.seq).toBe(initialState.seq + 1)
  })
})
