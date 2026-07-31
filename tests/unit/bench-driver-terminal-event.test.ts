/**
 * ALBB-04 turn.aborted registration in the bench SDK driver (round-4 audit).
 *
 * ALBB-04 added a dedicated `turn.aborted` terminal wire event and registered it
 * in protocol/events, web-frontend, and attach/render — but the bench SDK driver's
 * `lastTerminalTurnEventOf` matched only `turn.completed`/`turn.failed`. On a
 * cooperative RETURN-abort (a deadline/budget abort that surfaced a partial patch),
 * the kernel now emits `turn.aborted` with a DEFINED turnResult, so the driver's
 * empty-outcome fallback is skipped, the terminal lookup returns undefined, and the
 * driver THROWS — discarding the honest partial patch (re-opening the #10097 mode).
 *
 * RED-on-injection: dropping `turn.aborted` from the matcher makes the first case
 * return undefined ⇒ the driver would throw.
 */

import { describe, expect, test } from "bun:test"
import { lastTerminalTurnEventOf } from "@/apps/bench/eval/driver"
import type { SessionEvent } from "@/protocol/session"

const ev = (type: string, extra: Record<string, unknown> = {}): SessionEvent =>
  ({ eventId: "e", seq: 1, revision: 1, emittedAt: "t", type, ...extra }) as unknown as SessionEvent

describe("bench driver terminal-event resolution — ALBB-04 turn.aborted", () => {
  test("a turn.aborted terminal IS recognized (was missed ⇒ driver threw, discarding the patch)", () => {
    const events = [
      ev("turn.started"),
      ev("tool.invoked"),
      ev("turn.aborted", { message: "deadline" }),
    ]
    const terminal = lastTerminalTurnEventOf(events)
    expect(terminal?.type).toBe("turn.aborted")
  })

  test("turn.completed / turn.failed still recognized (control)", () => {
    expect(
      lastTerminalTurnEventOf([ev("turn.completed", { outcomeReason: "completed" })])?.type,
    ).toBe("turn.completed")
    expect(lastTerminalTurnEventOf([ev("turn.failed", { message: "x" })])?.type).toBe("turn.failed")
  })

  test("returns the LAST terminal, skipping trailing non-terminal events", () => {
    const events = [ev("turn.aborted", { message: "a" }), ev("tool.completed"), ev("usage")]
    expect(lastTerminalTurnEventOf(events)?.type).toBe("turn.aborted")
  })

  test("no terminal event ⇒ undefined (the fallback path)", () => {
    expect(lastTerminalTurnEventOf([ev("turn.started"), ev("tool.invoked")])).toBeUndefined()
  })
})
