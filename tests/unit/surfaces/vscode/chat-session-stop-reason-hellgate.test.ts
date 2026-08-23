/**
 * HELLGATE — the VS Code adapter does not launder a failed stop into Idle
 * (aug-23 §13 / slice 1d)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §13. The adapter's
 * `turn.completed` arm sets `status = Idle` unconditionally and DISCARDS
 * `outcomeReason` entirely (`surfaces/vscode/src/chat-session-adapter.ts:174`).
 * `turn.failed` is the only path that reaches `Failed` — but the loop reports
 * provider errors, refusals, turn-limit exhaustion and budget caps as an
 * ORDINARY `turn.completed` with a non-`completed` reason. So in the editor a
 * rate-limited or refused turn is indistinguishable from a clean one.
 *
 * `CHAT_SESSION_STATUS` already has the vocabulary (`Idle`/`InProgress`/
 * `Failed`); the adapter simply never consults the reason.
 *
 * Invariants:
 *
 *  H1  A non-success `turn.completed` does NOT settle as Idle.
 *  H2  PAIRED CONTROL — a genuine `completed` still settles as Idle, so the
 *      fix cannot be "always Failed".
 *  H3  BACK-COMPAT — the legacy shape (no `stopCategory`) is classified off
 *      `outcomeReason` alone; the adapter must not require the new field.
 *  H4  UNKNOWN sentinel (slice 1c) is not treated as a completion.
 *  H5  `turn.failed` still reaches Failed (pre-existing behavior preserved).
 */

import { describe, expect, test } from "bun:test"
import {
  ChatSessionProjection,
  type SessionPort,
  statusForTurnCompleted,
} from "@surfaces/vscode/chat-session-adapter"
import { CHAT_SESSION_STATUS } from "@surfaces/vscode/status"
import type { SessionEvent, SessionSnapshotLite, SessionTransportMessage } from "@/protocol/session"

const completedEvent = (
  outcomeReason: string,
  stopCategory?: { kind: string; reasonCode: string },
): Extract<SessionEvent, { type: "turn.completed" }> => ({
  eventId: "e1",
  seq: 1,
  revision: 1,
  emittedAt: "2026-08-23T00:00:00.000Z",
  type: "turn.completed",
  outcomeReason,
  ...(stopCategory !== undefined ? { stopCategory } : {}),
})

describe("H1 — a non-success completion is not laundered into Idle", () => {
  test.each([
    ["error"],
    ["refusal"],
    ["max_turns"],
    ["budget_exhausted"],
    ["awaiting_approval"],
  ])("%s ⇒ NOT Idle", (reason) => {
    expect(statusForTurnCompleted(completedEvent(reason))).not.toBe(CHAT_SESSION_STATUS.Idle)
  })

  test("a provider failure reads as Failed", () => {
    expect(statusForTurnCompleted(completedEvent("error"))).toBe(CHAT_SESSION_STATUS.Failed)
  })
})

describe("H1b — awaiting_approval is a PAUSE, not a failure (audit R-obj)", () => {
  /* The first cut of this fix bucketed every non-`completed` reason as Failed,
     which turned a paused-for-approval turn into an error badge — wrong in a
     NEW way, and in direct conflict with `statusForStateView`, whose comment
     states `awaiting_approval` is deliberately InProgress because the turn has
     not ended. The two mappers must agree. */
  test("awaiting_approval ⇒ InProgress, not Failed", () => {
    expect(statusForTurnCompleted(completedEvent("awaiting_approval"))).toBe(
      CHAT_SESSION_STATUS.InProgress,
    )
  })

  test("it is still not Idle", () => {
    expect(statusForTurnCompleted(completedEvent("awaiting_approval"))).not.toBe(
      CHAT_SESSION_STATUS.Idle,
    )
  })
})

describe("H2 — paired control: a clean completion still settles Idle", () => {
  test("completed ⇒ Idle", () => {
    expect(statusForTurnCompleted(completedEvent("completed"))).toBe(CHAT_SESSION_STATUS.Idle)
  })

  test("the structured category agrees", () => {
    expect(
      statusForTurnCompleted(
        completedEvent("completed", { kind: "completed", reasonCode: "completed.normal" }),
      ),
    ).toBe(CHAT_SESSION_STATUS.Idle)
  })
})

describe("H3 — back-compat: classified off outcomeReason alone", () => {
  test("no stopCategory present ⇒ still classified", () => {
    expect(statusForTurnCompleted(completedEvent("max_turns"))).not.toBe(CHAT_SESSION_STATUS.Idle)
    expect(statusForTurnCompleted(completedEvent("completed"))).toBe(CHAT_SESSION_STATUS.Idle)
  })
})

describe("H4 — the unknown sentinel is not a completion", () => {
  test("unknown ⇒ NOT Idle", () => {
    expect(statusForTurnCompleted(completedEvent("unknown"))).not.toBe(CHAT_SESSION_STATUS.Idle)
  })
})

/* ------------------------------------------------------------------------- *
 * H7 — WIRING PROOF (audit R1 finding #2)
 *
 * The pure-function tests above cannot catch the real defect: the kernel emits
 * `turn.completed` IMMEDIATELY followed by `session.state.updated` with
 * `status:"idle"`, and `applyStateView` overwrites whatever the completion arm
 * just set. A fix proven only against the pure mapper is INERT in production.
 * These drive the real event PAIR through the projection.
 * ------------------------------------------------------------------------- */

const SESSION_ID = "s-1"

const makePort = (): { port: SessionPort; feed: (m: SessionTransportMessage) => void } => {
  let handler: ((m: SessionTransportMessage) => void) | undefined
  const port = {
    sessionId: SESSION_ID,
    onMessage: (h: (m: SessionTransportMessage) => void) => {
      handler = h
      return () => undefined
    },
    send: () => undefined,
  } as unknown as SessionPort
  return {
    port,
    feed: (m) => {
      handler?.(m)
    },
  }
}

const stateUpdated = (status: string): SessionTransportMessage =>
  ({
    kind: "event",
    event: {
      eventId: "e-state",
      seq: 3,
      revision: 2,
      emittedAt: "2026-08-23T00:00:01.000Z",
      type: "session.state.updated",
      state: { status, draftInput: "", permissionMode: "default", messageCount: 2 },
    },
  }) as unknown as SessionTransportMessage

const completedMsg = (outcomeReason: string): SessionTransportMessage =>
  ({ kind: "event", event: completedEvent(outcomeReason) }) as unknown as SessionTransportMessage

describe("H7 — the real event pair, not just the pure mapper", () => {
  const drive = (outcomeReason: string, idleAfter = true) => {
    const { port, feed } = makePort()
    const projection = new ChatSessionProjection(port)
    feed(completedMsg(outcomeReason))
    if (idleAfter) feed(stateUpdated("idle"))
    return projection.current().status
  }

  test("a failed turn survives the trailing session.state.updated(idle)", () => {
    expect(drive("error")).toBe(CHAT_SESSION_STATUS.Failed)
  })

  test("max_turns survives it too", () => {
    expect(drive("max_turns")).toBe(CHAT_SESSION_STATUS.Failed)
  })

  test("paired control — a clean completion still settles Idle", () => {
    expect(drive("completed")).toBe(CHAT_SESSION_STATUS.Idle)
  })
})
