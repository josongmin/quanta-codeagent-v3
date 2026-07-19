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
  readServerAutoContinues,
  transcriptReducer,
} from "./session-hooks"

const baseStateView = (overrides: Partial<SessionStateView> = {}): SessionStateView => ({
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
    serverAutoContinues: false,
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

  it("accumulates turn.output.delta chunks in the streaming slot, NOT the messages array", () => {
    // PERF CONTRACT (streaming-out-of-array): the in-progress text lives ONLY in
    // `streamingAssistant`; `messages` holds just the finalized user row and its
    // reference stays STABLE across every delta (so the transcript viewport memo
    // bails per token — see reconcile-count.test).
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    const messagesRefAfterUser = state.messages
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("real "))
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("assistant "))
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("answer"))

    // messages: only the user row, and the SAME reference it was before any delta.
    expect(state.messages).toEqual([
      {
        id: "turn-1",
        role: "user",
        text: "hello",
        timestamp: "2026-05-26T13:00:00.000Z",
      },
    ])
    expect(state.messages).toBe(messagesRefAfterUser)

    // The accumulated live text is in the streaming slot (rendered as the tail).
    expect(state.streamingAssistant).toEqual({
      id: "assistant-stream-cmd-run-1",
      text: "real assistant answer",
      timestamp: "2026-05-26T13:00:02.000Z",
    })
  })

  it("REGRESSION: an unknown/forward-compat event type is a NO-OP that never poisons reducer state", () => {
    let state = applySessionEventToTranscript(initialTranscript, turnStartedEvent("hello"))
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("hi "))
    const before = state

    // A newly-added SessionEvent type the frontend does not recognize yet. The
    // default arm MUST return the same state (no-op) — the original bug fell
    // through to `undefined`, poisoning the reducer so the next delta crashed on
    // `state.streamingAssistant`.
    const unknownEvent = {
      type: "turn.some.future.kind",
      eventId: "future-1",
      emittedAt: "2026-05-26T13:00:03.000Z",
      seq: 99,
      revision: 0,
    } as unknown as SessionEvent
    state = applySessionEventToTranscript(state, unknownEvent)
    expect(state).toBe(before) // exact same reference: pure no-op, never undefined

    // The next REAL delta must still project without crashing. The live text
    // accumulates in the streaming slot (not `messages`) post streaming-out-of-array.
    state = applySessionEventToTranscript(state, turnOutputDeltaEvent("there"))
    expect(state).toBeDefined()
    expect(state.streamingAssistant?.text).toBe("hi there")
  })

  it("uses snapshot.streamingAssistantText to hydrate the live streaming slot mid-turn", () => {
    let state = initialTranscript
    state = applySessionEventToTranscript(state, turnStartedEvent("hello"))
    const messagesRefAfterUser = state.messages
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

    // The mid-turn streaming text hydrates the slot only — messages stays the
    // stable user-only array (rendered tail comes from the slot).
    expect(state.messages).toEqual([
      {
        id: "turn-1",
        role: "user",
        text: "hello",
        timestamp: "2026-05-26T13:00:00.000Z",
      },
    ])
    expect(state.messages).toBe(messagesRefAfterUser)
    expect(state.streamingAssistant).toEqual({
      id: "assistant-stream-2026-05-26T13:00:02.500Z",
      text: "real assistant answer",
      timestamp: "2026-05-26T13:00:02.500Z",
    })
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

  it("markEventSeen is FIFO-bounded: caps memory yet still dedups the recent window", () => {
    const cap = 8
    const seen = new Set<string>()
    for (let i = 0; i < cap * 3; i++) {
      expect(markEventSeen(seen, `e${i}`, cap)).toBe(true)
    }
    // Bound holds — the set never grows past cap despite 3× the ids.
    expect(seen.size).toBe(cap)
    // Recent window still dedups (the last `cap` ids are remembered).
    expect(markEventSeen(seen, `e${cap * 3 - 1}`, cap)).toBe(false)
    // The oldest evicted id is forgotten (a stale replay far outside the
    // overlap window is treated as first-sight — acceptable, never replayed).
    expect(seen.has("e0")).toBe(false)
    expect(markEventSeen(seen, "e0", cap)).toBe(true)
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

  // UUX-1-12 — the four additive observability events render as system rows
  // (budget hard breach paints as an error row); none touch the streaming slot.
  it("renders the additive observability events as transcript rows", () => {
    const base = { seq: 9, revision: 3, emittedAt: "2026-07-10T00:00:00.000Z" }
    let state = initialTranscript
    state = applySessionEventToTranscript(state, {
      ...base,
      eventId: "tp-1",
      type: "tool.progress",
      toolCallId: "c1",
      toolName: "bash",
      message: "installing deps",
    })
    state = applySessionEventToTranscript(state, {
      ...base,
      eventId: "rec-1",
      type: "turn.recovery",
      reason: "compact",
      detail: "window full",
    })
    state = applySessionEventToTranscript(state, {
      ...base,
      eventId: "cc-1",
      type: "context.compacted",
      fromTurnId: "t1",
      toTurnId: "t9",
      summary: "explored the repo",
      ts: 1,
      tokens: 4200,
    })
    state = applySessionEventToTranscript(state, {
      ...base,
      eventId: "bb-1",
      type: "budget.breach",
      severity: "hard",
      scope: "session-x",
      observed: 5.5,
      limit: 5,
    })

    expect(state.messages.map((m) => ({ role: m.role, text: m.text }))).toEqual([
      { role: "system", text: "⋯ bash: installing deps" },
      { role: "system", text: "↻ recovery (compact): window full" },
      { role: "system", text: "🗜 context compacted (4200 tokens summarized): explored the repo" },
      { role: "error", text: "💰 budget hard cap crossed (session-x): $5.5000 of $5.0000" },
    ])
    // Pure observation: the streaming assistant slot is untouched.
    expect(state.streamingAssistant).toBeNull()
  })

  it("soft budget breach stays a gray system row (not an error)", () => {
    const state = applySessionEventToTranscript(initialTranscript, {
      eventId: "bb-2",
      seq: 1,
      revision: 1,
      emittedAt: "2026-07-10T00:00:01.000Z",
      type: "budget.breach",
      severity: "soft",
      scope: "daily-2026-07-10",
      observed: 1.25,
      limit: 1,
    })
    expect(state.messages[0]?.role).toBe("system")
    expect(state.messages[0]?.text).toContain("soft")
  })
})

describe("readServerAutoContinues — defensive read (ADR-0540 W1-B, audit M-2)", () => {
  it("marker true ⇒ daemon-owned continuation", () => {
    expect(readServerAutoContinues({ serverAutoContinues: true })).toBe(true)
  })
  it("marker false ⇒ client-owned continuation", () => {
    expect(readServerAutoContinues({ serverAutoContinues: false })).toBe(false)
  })
  it("LEGACY daemon (field ABSENT) ⇒ false — guards the stall direction", () => {
    // A legacy snapshot predating the field must NOT read as daemon-owned: a
    // stuck-true here would make the browser skip its post-approval turn.run
    // re-issue against a daemon that never re-issues (ADR-0512 P3 stall).
    expect(readServerAutoContinues({} as { serverAutoContinues?: boolean })).toBe(false)
  })
})
