/**
 * ADVERSARIAL finalization edge-case suite for the streaming-out-of-array
 * refactor. The delicate invariant: the live streaming text lives ONLY in the
 * `streamingAssistant` slot during a turn, and on finalization it is converted
 * into an APPENDED assistant message EXACTLY ONCE — never double-rendered, never
 * dropped — preserving the canonical-text override + outcome-reason fallback +
 * signature dedup behavior that existed when the text was mirrored into
 * `messages` mid-stream.
 *
 * Every test asserts on the FINAL `messages` array (what the transcript renders)
 * and on the streaming slot being cleared, so a regression that drops, doubles,
 * or leaks the streaming row is caught.
 */
import { describe, expect, it } from "vitest"
import type { SessionEvent, SessionStateView } from "../types/protocol"
import {
  applySessionEventToTranscript,
  initialTranscript,
  type TranscriptState,
  transcriptReducer,
} from "./session-hooks"

const TS = "2026-05-26T13:00:00.000Z"

const started = (prompt: string): SessionEvent =>
  ({
    eventId: "turn-1",
    seq: 1,
    revision: 1,
    emittedAt: TS,
    type: "turn.started",
    prompt,
  }) as Extract<SessionEvent, { type: "turn.started" }>

const delta = (text: string): SessionEvent =>
  ({
    eventId: crypto.randomUUID(),
    seq: 2,
    revision: 1,
    emittedAt: "2026-05-26T13:00:02.000Z",
    causedByCommandId: "cmd-run-1",
    type: "turn.output.delta",
    delta: text,
  }) as Extract<SessionEvent, { type: "turn.output.delta" }>

const completed = (outcomeReason: string, assistantText?: string): SessionEvent =>
  ({
    eventId: "turn-1-complete",
    seq: 3,
    revision: 1,
    emittedAt: "2026-05-26T13:00:05.000Z",
    type: "turn.completed",
    outcomeReason,
    ...(assistantText !== undefined ? { assistantText } : {}),
  }) as Extract<SessionEvent, { type: "turn.completed" }>

const failed = (message: string): SessionEvent =>
  ({
    eventId: "turn-1-failed",
    seq: 3,
    revision: 1,
    emittedAt: "2026-05-26T13:00:05.000Z",
    type: "turn.failed",
    message,
  }) as Extract<SessionEvent, { type: "turn.failed" }>

const stateUpdated = (state: SessionStateView): SessionEvent =>
  ({
    eventId: "state-1",
    seq: 4,
    revision: 1,
    emittedAt: "2026-05-26T13:00:05.100Z",
    type: "session.state.updated",
    state,
  }) as Extract<SessionEvent, { type: "session.state.updated" }>

const view = (overrides: Partial<SessionStateView>): SessionStateView => ({
  status: "idle",
  draftInput: "",
  permissionMode: "default",
  messageCount: 0,
  ...overrides,
})

const drive = (events: readonly SessionEvent[]): TranscriptState =>
  events.reduce(applySessionEventToTranscript, initialTranscript)

const assistantRows = (s: TranscriptState) => s.messages.filter((m) => m.role === "assistant")

describe("streaming finalization — adversarial edge cases", () => {
  it("HAPPY PATH: deltas → completed(text) → idle(canonical) appends exactly ONE canonical row", () => {
    const s = drive([
      started("hello"),
      delta("real "),
      delta("assistant answer"),
      completed("completed", "real assistant answer"),
      stateUpdated(
        view({ status: "idle", messageCount: 2, lastAssistantText: "real assistant answer" }),
      ),
    ])
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]).toEqual({
      id: "assistant-stream-cmd-run-1",
      role: "assistant",
      text: "real assistant answer",
      timestamp: "2026-05-26T13:00:02.000Z",
    })
    expect(s.streamingAssistant).toBeNull()
  })

  it("CANONICAL OVERRIDE: a shorter/wrong streamed body is replaced by the canonical idle text", () => {
    const s = drive([
      started("hello"),
      delta("par"),
      delta("tial"),
      completed("completed"),
      stateUpdated(
        view({ status: "idle", messageCount: 2, lastAssistantText: "the full canonical answer" }),
      ),
    ])
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("the full canonical answer")
    expect(s.streamingAssistant).toBeNull()
  })

  it("STREAMED FALLBACK: completion carries no canonical text ⇒ finalize with what we streamed", () => {
    const s = drive([
      started("hello"),
      delta("streamed body only"),
      completed("completed"),
      stateUpdated(view({ status: "idle", messageCount: 2 })), // no lastAssistantText
    ])
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("streamed body only")
    expect(s.streamingAssistant).toBeNull()
  })

  it("EMPTY COMPLETION: no deltas, completion 'completed' without text ⇒ single outcome-reason fallback row", () => {
    // `fallbackTextOf`: no assistantText ⇒ use the (non-empty) outcomeReason.
    const s = drive([
      started("hello"),
      completed("completed"),
      stateUpdated(view({ status: "idle", messageCount: 1 })),
    ])
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]).toEqual({
      id: "turn-1-complete",
      role: "assistant",
      text: "completed",
      timestamp: "2026-05-26T13:00:05.000Z",
    })
    expect(s.streamingAssistant).toBeNull()
  })

  it("EMPTY COMPLETION with blank outcome ⇒ '(turn completed)' placeholder row", () => {
    const s = drive([
      started("hello"),
      completed(""), // both assistantText and outcomeReason empty
      stateUpdated(view({ status: "idle", messageCount: 1 })),
    ])
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("(turn completed)")
    expect(s.streamingAssistant).toBeNull()
  })

  it("OUTCOME FALLBACK: no deltas, completion 'cancelled' with no text ⇒ outcome-reason row", () => {
    const s = drive([
      started("hello"),
      completed("cancelled"),
      stateUpdated(view({ status: "idle", messageCount: 1 })),
    ])
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("cancelled")
  })

  it("FALLBACK ROW REPAIR: a fallback row is repaired IN PLACE by a later canonical snapshot (no double)", () => {
    let s = drive([
      started("hello"),
      completed("completed"),
      stateUpdated(view({ status: "idle", messageCount: 1 })), // appends outcome-reason fallback row
    ])
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("completed")

    // A later snapshot carries the real assistant text — repair, do not append.
    s = applySessionEventToTranscript(
      s,
      stateUpdated(view({ status: "idle", messageCount: 2, lastAssistantText: "real answer" })),
    )
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("real answer")
    expect(assistantRows(s)[0]?.id).toBe("turn-1-complete")
  })

  it("IDEMPOTENT: a repeated identical idle snapshot after finalize does NOT duplicate the row", () => {
    const canonical = stateUpdated(
      view({ status: "idle", messageCount: 2, lastAssistantText: "answer" }),
    )
    let s = drive([started("hi"), delta("ans"), delta("wer"), completed("completed"), canonical])
    expect(assistantRows(s)).toHaveLength(1)
    s = applySessionEventToTranscript(s, canonical) // same signature → no-op
    s = applySessionEventToTranscript(s, canonical)
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("answer")
  })

  it("TURN.FAILED mid-stream: keeps the partial assistant bubble ABOVE the error row", () => {
    const s = drive([started("hello"), delta("half a thou"), failed("boom")])
    // partial assistant row preserved, then the error row.
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["assistant", "half a thou"],
      ["error", "boom"],
    ])
    expect(s.streamingAssistant).toBeNull()
  })

  it("TURN.FAILED with an empty stream: only the error row, no empty assistant bubble", () => {
    const s = drive([started("hello"), failed("boom")])
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["error", "boom"],
    ])
    expect(assistantRows(s)).toHaveLength(0)
    expect(s.streamingAssistant).toBeNull()
  })

  it("RESET mid-stream: the reducer 'reset' action clears the slot and transcript, no orphan row", () => {
    // Drive REAL state to mid-stream, then fire the reducer's reset action (what
    // `resetTranscript` / a session switch dispatches) and assert nothing leaks.
    const mid = drive([started("hello"), delta("partial answer")])
    expect(mid.streamingAssistant?.text).toBe("partial answer")
    expect(mid.messages).toHaveLength(1)

    const afterReset = transcriptReducer(mid, { type: "reset" })
    expect(afterReset.messages).toHaveLength(0)
    expect(afterReset.streamingAssistant).toBeNull()
    expect(afterReset.pendingCompletion).toBeNull()
  })

  it("NEW TURN mid-stream (defensive): a lingering partial is finalized before the new user row", () => {
    // A `turn.started` arriving while a non-empty slot lingers must not drop the
    // partial (pre-refactor it lived in `messages` and survived).
    const s = drive([
      started("first"),
      delta("lingering partial"),
      // No completion — a second turn.started barges in.
      {
        ...(started("second") as Extract<SessionEvent, { type: "turn.started" }>),
        eventId: "turn-2",
      },
    ])
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "first"],
      ["assistant", "lingering partial"],
      ["user", "second"],
    ])
    expect(s.streamingAssistant).toBeNull()
  })

  it("uses turn.completed.assistantText when the idle snapshot lacks canonical text", () => {
    const s = drive([
      started("hello"),
      completed("completed", "from completion event"),
      stateUpdated(view({ status: "idle", messageCount: 1 })),
    ])
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("from completion event")
  })

  it("no-drop / no-double across the WHOLE happy sequence: exactly one assistant row, slot empty", () => {
    const s = drive([
      started("q"),
      delta("a"),
      delta("b"),
      delta("c"),
      completed("completed", "abc"),
      stateUpdated(view({ status: "idle", messageCount: 2, lastAssistantText: "abc" })),
    ])
    expect(s.messages).toHaveLength(2) // user + one assistant
    expect(assistantRows(s)).toHaveLength(1)
    expect(assistantRows(s)[0]?.text).toBe("abc")
    expect(s.streamingAssistant).toBeNull()
    expect(s.pendingCompletion).toBeNull()
    expect(s.fallbackCompletion).toBeNull()
  })
})
