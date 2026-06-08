import { describe, expect, it } from "vitest"
import type {
  SessionEvent,
  SessionRejectedFrame,
  SessionSnapshotLite,
  SessionStateView,
} from "../types/protocol"
import {
  applyDedupedEvent,
  applyRejectedFrameToTranscript,
  applySessionEventToTranscript,
  initialTranscript,
  markEventSeen,
  transcriptReducer,
} from "./session-hooks"

const baseStateView = (
  overrides: Partial<SessionStateView> = {},
): SessionStateView => ({
  status: "idle",
  draftInput: "",
  permissionMode: "default",
  messageCount: 0,
  ...overrides,
})

const turnStartedEvent = (prompt: string): Extract<SessionEvent, { type: "turn.started" }> => ({
  eventId: "turn-1",
  seq: 1,
  revision: 1,
  emittedAt: "2026-05-26T13:00:00.000Z",
  type: "turn.started",
  prompt,
})

const turnCompletedEvent = (
  outcomeReason: string,
  assistantText?: string,
): Extract<SessionEvent, { type: "turn.completed" }> => ({
  eventId: "turn-1-complete",
  seq: 2,
  revision: 1,
  emittedAt: "2026-05-26T13:00:05.000Z",
  type: "turn.completed",
  outcomeReason,
  ...(assistantText !== undefined ? { assistantText } : {}),
})

const turnOutputDeltaEvent = (
  delta: string,
): Extract<SessionEvent, { type: "turn.output.delta" }> => ({
  eventId: crypto.randomUUID(),
  seq: 2,
  revision: 1,
  emittedAt: "2026-05-26T13:00:02.000Z",
  causedByCommandId: "cmd-run-1",
  type: "turn.output.delta",
  delta,
})

const sessionStateUpdatedEvent = (
  state: SessionStateView,
): Extract<SessionEvent, { type: "session.state.updated" }> => ({
  eventId: "state-1",
  seq: 3,
  revision: 1,
  emittedAt: "2026-05-26T13:00:05.100Z",
  type: "session.state.updated",
  state,
})

const snapshot = (state: SessionStateView): SessionSnapshotLite => ({
  sessionId: "srv-1",
  revision: 3,
  seq: 5,
  state,
  capabilities: {
    approvals: "none",
    tools: true,
    memory: false,
    artifacts: false,
    subagents: false,
    automation: false,
    shellSnapshot: false,
    transport: "websocket",
  },
  pendingApproval: null,
  openArtifacts: [],
})

describe("session-hooks transcript projection", () => {
  it("uses lastAssistantText instead of outcomeReason for assistant rows", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    state = applySessionEventToTranscript(state, turnCompletedEvent("completed"))
    state = applySessionEventToTranscript(
      state,
      sessionStateUpdatedEvent(
        baseStateView({
          messageCount: 2,
          lastUserText: "hello",
          lastAssistantText: "real assistant answer",
        }),
      ),
    )

    expect(state.messages).toEqual([
      {
        id: "turn-1",
        role: "user",
        text: "hello",
        timestamp: "2026-05-26T13:00:00.000Z",
      },
      {
        id: "turn-1-complete",
        role: "assistant",
        text: "real assistant answer",
        timestamp: "2026-05-26T13:00:05.000Z",
      },
    ])
  })

  it("does not duplicate assistant rows on repeated identical state snapshots", () => {
    const completionState = sessionStateUpdatedEvent(
      baseStateView({
        messageCount: 2,
        lastUserText: "hello",
        lastAssistantText: "same answer",
      }),
    )

    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    state = applySessionEventToTranscript(state, turnCompletedEvent("ok"))
    state = applySessionEventToTranscript(state, completionState)
    state = applySessionEventToTranscript(state, completionState)

    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]?.text).toBe("same answer")
  })

  it("carries turn.started image attachments into the user bubble", () => {
    const started = {
      ...turnStartedEvent(""),
      images: [{ type: "image" as const, data: "Zm9v", mediaType: "image/png" }],
    }

    const state = applySessionEventToTranscript(initialTranscript, started)

    expect(state.messages).toEqual([
      {
        id: "turn-1",
        role: "user",
        text: "",
        timestamp: "2026-05-26T13:00:00.000Z",
        images: [{ type: "image", data: "Zm9v", mediaType: "image/png" }],
      },
    ])
  })

  it("appends turn.output.delta chunks into a single assistant row", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("real "))
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("assistant "))
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("answer"))

    expect(state.messages).toEqual([
      {
        id: "turn-1",
        role: "user",
        text: "hello",
        timestamp: "2026-05-26T13:00:00.000Z",
      },
      {
        id: "assistant-stream-cmd-run-1",
        role: "assistant",
        text: "real assistant answer",
        timestamp: "2026-05-26T13:00:02.000Z",
      },
    ])
  })

  it("uses snapshot.streamingAssistantText to repair the live assistant row mid-turn", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    state = transcriptReducer(state, {
      type: "snapshot",
      snapshot: snapshot(
        baseStateView({
          status: "running",
          messageCount: 1,
          lastUserText: "hello",
          streamingAssistantText: "real assistant answer",
        }),
      ),
      receivedAt: "2026-05-26T13:00:02.500Z",
    })

    expect(state.messages).toEqual([
      {
        id: "turn-1",
        role: "user",
        text: "hello",
        timestamp: "2026-05-26T13:00:00.000Z",
      },
      {
        id: "assistant-stream-2026-05-26T13:00:02.500Z",
        role: "assistant",
        text: "real assistant answer",
        timestamp: "2026-05-26T13:00:02.500Z",
      },
    ])
  })

  it("falls back to outcomeReason only when no assistant text is present", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    state = applySessionEventToTranscript(state, turnCompletedEvent("cancelled"))
    state = applySessionEventToTranscript(
      state,
      sessionStateUpdatedEvent(
        baseStateView({
          status: "idle",
          messageCount: 1,
          lastUserText: "hello",
        }),
      ),
    )

    expect(state.messages[1]).toEqual({
      id: "turn-1-complete",
      role: "assistant",
      text: "cancelled",
      timestamp: "2026-05-26T13:00:05.000Z",
    })
  })

  it("uses assistantText from turn.completed when idle state lacks assistant text", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    state = applySessionEventToTranscript(
      state,
      turnCompletedEvent("completed", "real assistant answer"),
    )
    state = applySessionEventToTranscript(
      state,
      sessionStateUpdatedEvent(
        baseStateView({
          status: "idle",
          messageCount: 1,
          lastUserText: "hello",
        }),
      ),
    )

    expect(state.messages[1]).toEqual({
      id: "turn-1-complete",
      role: "assistant",
      text: "real assistant answer",
      timestamp: "2026-05-26T13:00:05.000Z",
    })
  })

  it("repairs a fallback 'completed' row when a later snapshot carries assistant text", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    state = applySessionEventToTranscript(state, turnCompletedEvent("completed"))
    state = applySessionEventToTranscript(
      state,
      sessionStateUpdatedEvent(
        baseStateView({
          status: "idle",
          messageCount: 1,
          lastUserText: "hello",
        }),
      ),
    )

    state = transcriptReducer(state, {
      type: "snapshot",
      snapshot: snapshot(
        baseStateView({
          status: "idle",
          messageCount: 2,
          lastUserText: "hello",
          lastAssistantText: "real assistant answer",
          lastOutcomeReason: "completed",
        }),
      ),
      receivedAt: "2026-05-26T13:00:05.200Z",
    })

    expect(state.messages).toEqual([
      {
        id: "turn-1",
        role: "user",
        text: "hello",
        timestamp: "2026-05-26T13:00:00.000Z",
      },
      {
        id: "turn-1-complete",
        role: "assistant",
        text: "real assistant answer",
        timestamp: "2026-05-26T13:00:05.000Z",
      },
    ])
  })

  it("reuses the streamed assistant row when completion snapshot lands", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("real "))
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("assistant answer"))
    state = applySessionEventToTranscript(state, turnCompletedEvent("completed"))
    state = applySessionEventToTranscript(
      state,
      sessionStateUpdatedEvent(
        baseStateView({
          status: "idle",
          messageCount: 2,
          lastUserText: "hello",
          lastAssistantText: "real assistant answer",
        }),
      ),
    )

    expect(state.messages).toEqual([
      {
        id: "turn-1",
        role: "user",
        text: "hello",
        timestamp: "2026-05-26T13:00:00.000Z",
      },
      {
        id: "assistant-stream-cmd-run-1",
        role: "assistant",
        text: "real assistant answer",
        timestamp: "2026-05-26T13:00:02.000Z",
      },
    ])
  })

  it("dedups a replayed+live overlap: the same eventId twice renders one message", () => {
    // Mirrors the hook's `seenEventIdsRef`: an event the daemon persisted is
    // replayed via HTTP hydration AND may also arrive as a live WS frame. The
    // dedup gate must apply it exactly once.
    const seen = new Set<string>()
    let state = initialTranscript

    const started = turnStartedEvent("hello")
    const first = applyDedupedEvent(state, seen, started)
    expect(first.applied).toBe(true)
    state = first.state

    // The SAME event (identical eventId) arrives again — must be a no-op.
    const dup = applyDedupedEvent(state, seen, started)
    expect(dup.applied).toBe(false)
    state = dup.state

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.id).toBe("turn-1")
  })

  it("markEventSeen returns true only on first sight of an eventId", () => {
    const seen = new Set<string>()
    expect(markEventSeen(seen, "e1")).toBe(true)
    expect(markEventSeen(seen, "e1")).toBe(false)
    expect(markEventSeen(seen, "e2")).toBe(true)
    expect(seen.has("e1")).toBe(true)
    expect(seen.has("e2")).toBe(true)
  })

  it("renders rejected command frames as error transcript rows", () => {
    const frame: SessionRejectedFrame = {
      target: "command",
      reason: "protocol_validation",
      commandId: "cmd-1",
      issue: "empty_turn_input",
    }

    const state = applyRejectedFrameToTranscript(
      initialTranscript,
      frame,
      "2026-05-26T13:00:06.000Z",
    )

    expect(state.messages).toEqual([
      {
        id: "cmd-1",
        role: "error",
        text: "turn rejected: empty_turn_input",
        timestamp: "2026-05-26T13:00:06.000Z",
      },
    ])
  })
})
