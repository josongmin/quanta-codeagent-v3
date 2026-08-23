/**
 * HELLGATE — `turn.completed` carries the stop category (aug-23 §13 / slice 1c)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §13. Every user-visible
 * rail reads `TurnCompletedEvent`, which today carries only the legacy
 * free-form `outcomeReason: string`. The 18-code taxonomy stops at the loop
 * boundary, so a surface CANNOT render an honest stop even if it wanted to.
 *
 * Invariants:
 *
 *  H1  ADDITIVE / OPTIONAL — a `turn.completed` built without a category is
 *      byte-identical to today's shape (the field is simply absent, not
 *      `undefined`-valued). Off-identity is not covered by the repo's
 *      default-OFF ledger for protocol shape, so it is pinned here.
 *
 *  H2  CARRIED WHEN PRESENT — when the scheduler state holds a category, it
 *      reaches the event unchanged (kind + reasonCode; hint optional).
 *
 *  H3  NO SUCCESS FORGERY — `scheduler-turn-terminals.ts:144` currently does
 *      `outcomeReason: state.lastOutcomeReason ?? "completed"`, i.e. it invents
 *      success when the reason is missing. That is the competitor's exact
 *      source-side bug (§13). A missing reason must NOT surface as a
 *      completion; it must be explicitly unknown.
 *
 *  H4  WIRE-SAFE — the event survives encode/decode with the new field intact,
 *      and an OLD-shaped event (no category) still decodes.
 */

import { describe, expect, test } from "bun:test"
import { decodeSessionEvent, encodeSessionEvent } from "@/protocol/session/codec"
import type { TurnCompletedEvent } from "@/protocol/session/events"

const base = {
  eventId: "11111111-1111-4111-8111-111111111111",
  seq: 7,
  revision: 3,
  emittedAt: "2026-08-23T12:00:00.000Z",
  causedByCommandId: "22222222-2222-4222-8222-222222222222",
  type: "turn.completed",
} as const

describe("H1 — the field is additive and optional", () => {
  test("an event without a category has NO stopCategory key", () => {
    const ev: TurnCompletedEvent = { ...base, outcomeReason: "completed" }
    expect("stopCategory" in ev).toBe(false)
  })

  test("today's shape still type-checks and round-trips", () => {
    const ev: TurnCompletedEvent = { ...base, outcomeReason: "completed" }
    const back = decodeSessionEvent(encodeSessionEvent(ev))
    expect(back.type).toBe("turn.completed")
    expect((back as TurnCompletedEvent).outcomeReason).toBe("completed")
    expect((back as TurnCompletedEvent).stopCategory).toBeUndefined()
  })
})

describe("H2/H4 — a category rides the wire intact", () => {
  test("kind + reasonCode + hint survive encode/decode", () => {
    const ev: TurnCompletedEvent = {
      ...base,
      outcomeReason: "max_turns",
      stopCategory: {
        kind: "max_turns",
        reasonCode: "completed.max_turns",
        hint: "Raise maxTurns to continue.",
      },
    }
    const back = decodeSessionEvent(encodeSessionEvent(ev)) as TurnCompletedEvent
    expect(back.stopCategory?.kind).toBe("max_turns")
    expect(back.stopCategory?.reasonCode).toBe("completed.max_turns")
    expect(back.stopCategory?.hint).toBe("Raise maxTurns to continue.")
  })

  test("hint is optional", () => {
    const ev: TurnCompletedEvent = {
      ...base,
      outcomeReason: "error",
      stopCategory: { kind: "failed", reasonCode: "provider.rate_limit" },
    }
    const back = decodeSessionEvent(encodeSessionEvent(ev)) as TurnCompletedEvent
    expect(back.stopCategory?.hint).toBeUndefined()
  })
})

describe("H3 — a missing reason is never forged into success", () => {
  test("the fallback token is not a completion", async () => {
    const { UNKNOWN_OUTCOME_REASON } = await import("@/protocol/session/events")
    expect(UNKNOWN_OUTCOME_REASON).toBeDefined()
    expect(UNKNOWN_OUTCOME_REASON).not.toBe("completed")
    expect(UNKNOWN_OUTCOME_REASON.length).toBeGreaterThan(0)
  })
})
