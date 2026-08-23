/**
 * HELLGATE — the web transcript surfaces WHY a turn stopped (aug-23 §13 / slice 1d)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §13, success-misreport
 * site #3. `fallbackTextOf` prefers `assistantText` over `outcomeReason`, so a
 * turn that stopped at the turn limit / on a provider error / on a refusal
 * renders as a plain assistant bubble with NO failure marking whenever the
 * model produced any prose first. The reason is on the event and is discarded.
 *
 * Slice 1c put a structured `stopCategory` on `turn.completed`. This pins that
 * the reducer keeps it, and that a non-success stop stays distinguishable from
 * a clean completion.
 *
 * Invariants:
 *
 *  H1  CARRIED — a `stopCategory` on the event reaches the finalized message.
 *  H2  NOT MASKED BY PROSE — a failed/limited stop WITH assistant text is still
 *      marked; the mark is not an either/or with the text.
 *  H3  CLEAN COMPLETION IS UNMARKED (paired control) — the fix cannot be
 *      "always mark", which would be a different lie.
 *  H4  BACK-COMPAT — an event with no `stopCategory` (old producer, and the
 *      shape every other test builds) behaves exactly as before.
 *  H5  UNKNOWN REASON IS NOT A COMPLETION — slice 1c emits `"unknown"` when the
 *      reason could not be resolved; it must not read as success.
 */

import { describe, expect, it } from "vitest"
import type { SessionEvent } from "../types/protocol"
import { applySessionEventToTranscript, initialTranscript } from "./session-hooks"

const started = (prompt: string): Extract<SessionEvent, { type: "turn.started" }> => ({
  eventId: "t1",
  seq: 1,
  revision: 1,
  emittedAt: "2026-08-23T13:00:00.000Z",
  type: "turn.started",
  prompt,
})

const completed = (args: {
  readonly outcomeReason: string
  readonly assistantText?: string
  readonly stopCategory?: { kind: string; reasonCode: string; hint?: string }
}): Extract<SessionEvent, { type: "turn.completed" }> => ({
  eventId: "t1-done",
  seq: 2,
  revision: 1,
  emittedAt: "2026-08-23T13:00:05.000Z",
  type: "turn.completed",
  outcomeReason: args.outcomeReason,
  ...(args.assistantText !== undefined ? { assistantText: args.assistantText } : {}),
  ...(args.stopCategory !== undefined ? { stopCategory: args.stopCategory } : {}),
})

/** A `turn.completed` is only FINALIZED into `messages` once the following
 *  `session.state.updated` lands (the reducer holds it as `pendingCompletion`
 *  until then) — mirror the real event order. */
const stateUpdated = (
  lastAssistantText?: string,
): Extract<SessionEvent, { type: "session.state.updated" }> => ({
  eventId: "t1-state",
  seq: 3,
  revision: 2,
  emittedAt: "2026-08-23T13:00:06.000Z",
  type: "session.state.updated",
  state: {
    status: "idle",
    draftInput: "",
    permissionMode: "default",
    messageCount: 2,
    lastUserText: "do the thing",
    ...(lastAssistantText !== undefined ? { lastAssistantText } : {}),
  },
})

const runTurn = (done: Extract<SessionEvent, { type: "turn.completed" }>) => {
  let state = initialTranscript
  state = applySessionEventToTranscript(state, started("do the thing")) ?? state
  state = applySessionEventToTranscript(state, done) ?? state
  return applySessionEventToTranscript(state, stateUpdated(done.assistantText)) ?? state
}

const lastAssistant = (state: ReturnType<typeof runTurn>) =>
  [...state.messages].reverse().find((m) => m.role === "assistant")

describe("H1/H2 — a non-success stop stays visible even with prose", () => {
  it("carries the stop category onto the finalized assistant message", () => {
    const state = runTurn(
      completed({
        outcomeReason: "max_turns",
        assistantText: "Here is what I found so far.",
        stopCategory: { kind: "max_turns", reasonCode: "completed.max_turns" },
      }),
    )
    const msg = lastAssistant(state)
    expect(msg).toBeDefined()
    expect(msg?.stopCategory?.reasonCode).toBe("completed.max_turns")
    // the prose is preserved — the mark is additive, not a replacement
    expect(msg?.text).toContain("Here is what I found so far.")
  })

  it("marks a provider failure that produced partial prose", () => {
    const state = runTurn(
      completed({
        outcomeReason: "error",
        assistantText: "Partial answer…",
        stopCategory: { kind: "failed", reasonCode: "provider.rate_limit" },
      }),
    )
    expect(lastAssistant(state)?.stopCategory?.kind).toBe("failed")
  })
})

describe("H3 — paired control: a clean completion is not marked", () => {
  it("completed.normal carries a success-kind category, not a failure one", () => {
    const state = runTurn(
      completed({
        outcomeReason: "completed",
        assistantText: "All done.",
        stopCategory: { kind: "completed", reasonCode: "completed.normal" },
      }),
    )
    const msg = lastAssistant(state)
    expect(msg?.stopCategory?.kind).toBe("completed")
    expect(msg?.text).toContain("All done.")
  })
})

describe("H4 — back-compat with a producer that sends no category", () => {
  it("an event without stopCategory finalizes exactly as before", () => {
    const state = runTurn(completed({ outcomeReason: "completed", assistantText: "hi" }))
    const msg = lastAssistant(state)
    expect(msg?.text).toContain("hi")
    expect(msg?.stopCategory).toBeUndefined()
  })

  it("still falls back to the reason string when there is no prose", () => {
    const state = runTurn(completed({ outcomeReason: "max_turns" }))
    expect(lastAssistant(state)?.text).toContain("max_turns")
  })
})

describe("H5 — an unresolved reason is not a completion", () => {
  it("the slice-1c unknown sentinel is not rendered as success copy", () => {
    const state = runTurn(completed({ outcomeReason: "unknown" }))
    const text = lastAssistant(state)?.text ?? ""
    expect(text).not.toBe("(turn completed)")
    expect(text.length).toBeGreaterThan(0)
  })
})
