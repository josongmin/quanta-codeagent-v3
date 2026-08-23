/**
 * HELLGATE — the CLI turn notification tells the truth (aug-23 §13 / slice 1d)
 *
 * Context: `docs/analysis/aug-23-grok-build-review.md` §13, success-misreport
 * site #2. `notifyTurnComplete` derives success as
 * `result !== undefined && !turnAborted` — presence, not outcome. Every
 * non-aborted terminal returns a result, so `error`, `refusal`, `max_turns`
 * and `budget_exhausted` ALL notify as `✓ … — done`. That is precisely the
 * competitor bug the audit documents: a stop that left work undone rendering
 * as a completion.
 *
 * `RunSessionTurnResult` already carries `outcomeReason`; nothing new has to
 * be plumbed — the notifier simply never looked at it.
 *
 * Invariants:
 *
 *  H1  ONLY a genuine completion is ok. `completed` ⇒ ok:true; every other
 *      `StopReason` ⇒ ok:false. Driven off the shipped presentation table
 *      (slice 1b), so a future code cannot quietly re-enter the success path.
 *
 *  H2  ABORT still reads as not-ok (pre-existing behavior preserved).
 *
 *  H3  UNKNOWN / absent reason is NOT ok. An unresolved outcome is not a
 *      verified completion — the same rule slice 1c applied at the source.
 *
 *  H4  PAIRED CONTROL — a genuine completion is unaffected, so the fix cannot
 *      be "always false".
 *
 *  H5  NO-OP WITHOUT A PORT — absent `notify` ⇒ nothing observable (the
 *      byte-identical guarantee the helper documents).
 */

import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import type { NotificationPort, TurnCompleteInfo } from "@/apps/cli/notify"
import { notifyTurnComplete } from "@/apps/cli/repl/session-loop/turn-helpers"

const recorder = (): { port: NotificationPort; seen: TurnCompleteInfo[] } => {
  const seen: TurnCompleteInfo[] = []
  const port = {
    onTurnComplete: (info: TurnCompleteInfo) => {
      seen.push(info)
    },
    onIdleAwaitingInput: () => undefined,
    markActive: () => undefined,
    getPushStats: () => ({ sent: 0, suppressedUserPresent: 0 }),
  } as unknown as NotificationPort
  return { port, seen }
}

const notify = (
  outcomeReason: AgentOutcome["reason"] | undefined,
  turnAborted = false,
): TurnCompleteInfo => {
  const { port, seen } = recorder()
  notifyTurnComplete(
    port,
    {
      durationMs: 5_000,
      result: { messages: [], ...(outcomeReason !== undefined ? { outcomeReason } : {}) },
      turnAborted,
    },
    "proj",
  )
  const info = seen[0]
  if (info === undefined) throw new Error("notification not emitted")
  return info
}

describe("H1 — only a genuine completion notifies as ok", () => {
  test("completed ⇒ ok", () => {
    expect(notify("completed").ok).toBe(true)
  })

  test.each([
    ["error"],
    ["refusal"],
    ["max_turns"],
    ["budget_exhausted"],
    ["awaiting_approval"],
    ["aborted"],
  ] as const)("%s ⇒ NOT ok", (reason) => {
    expect(notify(reason as AgentOutcome["reason"]).ok).toBe(false)
  })
})

describe("H2 — an aborted turn stays not-ok", () => {
  test("abort overrides even a completed reason", () => {
    expect(notify("completed", true).ok).toBe(false)
  })
})

describe("H3 — an unresolved outcome is not a completion", () => {
  test("absent outcomeReason ⇒ NOT ok", () => {
    expect(notify(undefined).ok).toBe(false)
  })
})

describe("H4 — paired control: the fix is not 'always false'", () => {
  test("the completed case is still the only true", () => {
    const oks = (["completed", "error", "refusal", "max_turns", "budget_exhausted"] as const).map(
      (r) => notify(r as AgentOutcome["reason"]).ok,
    )
    expect(oks).toEqual([true, false, false, false, false])
  })
})

describe("H6 — both result shapes are read", () => {
  /* `RunOneTurnResult.result` is generic. The session-loop path yields a
     `RunSessionTurnResult` (`outcomeReason`); the one-shot path yields the
     `AgentOutcome` itself (`reason`). Privileging one shape silently marks the
     other's completions as not-ok — caught by the live e2e when this fix first
     read only `outcomeReason`. */
  const notifyRaw = (result: unknown): TurnCompleteInfo => {
    const { port, seen } = recorder()
    notifyTurnComplete(port, { durationMs: 5_000, result, turnAborted: false }, "proj")
    const info = seen[0]
    if (info === undefined) throw new Error("notification not emitted")
    return info
  }

  test("AgentOutcome shape (`reason`) is honored", () => {
    expect(notifyRaw({ reason: "completed", turns: 2, messages: [] }).ok).toBe(true)
    expect(notifyRaw({ reason: "max_turns", turns: 9, messages: [] }).ok).toBe(false)
  })

  test("RunSessionTurnResult shape (`outcomeReason`) is honored", () => {
    expect(notifyRaw({ messages: [], outcomeReason: "completed" }).ok).toBe(true)
    expect(notifyRaw({ messages: [], outcomeReason: "error" }).ok).toBe(false)
  })

  test("a result carrying NEITHER field is not ok", () => {
    expect(notifyRaw({ messages: [] }).ok).toBe(false)
  })
})

describe("H5 — no port ⇒ no observable effect", () => {
  test("absent notify is a no-op", () => {
    expect(() => {
      notifyTurnComplete(
        undefined,
        { durationMs: 5_000, result: { messages: [] }, turnAborted: false },
        "proj",
      )
    }).not.toThrow()
  })
})
