/**
 * Mid-turn approval channel — the fix for "the approval input box never appeared
 * and it auto-denied" (a mid-turn approval fighting the in-turn keystroke reader
 * for stdin). These pin the routing contract.
 */
import { describe, expect, test } from "bun:test"
import { createMidTurnApprovalChannel } from "@/apps/cli/repl/mid-turn-approval-channel"

// WS-A (jul-10) — the channel resolves a TYPED result: `{kind:"line"}` for real
// operator input vs `{kind:"released", cause}` for a channel release (the old
// bare-"" release masqueraded as an operator empty line — UUX-1-22). The richer
// release pins live in
// `src/apps/cli/repl/__tests__/mid-turn-approval-channel-release.hellgate.test.ts`.
describe("mid-turn approval channel", () => {
  test("a captured line resolves a waiting approval (routed, not queued)", async () => {
    const ch = createMidTurnApprovalChannel()
    const answer = ch.awaitLine()
    expect(ch.tryResolve("y")).toBe(true) // consumed by the approval
    expect(await answer).toEqual({ kind: "line", line: "y" })
  })

  test("tryResolve returns false when no approval is pending (line falls through to follow-up routing)", () => {
    const ch = createMidTurnApprovalChannel()
    expect(ch.tryResolve("some follow-up")).toBe(false)
  })

  test("clear(turn_teardown) releases a waiter TYPED so a turn ending mid-approval denies (fail-closed)", async () => {
    const ch = createMidTurnApprovalChannel()
    const answer = ch.awaitLine()
    ch.clear("turn_teardown")
    expect(await answer).toEqual({ kind: "released", cause: "turn_teardown" })
    expect(ch.tryResolve("late")).toBe(false) // already cleared
  })

  test("C2 (jul-10 audit): concurrent asks QUEUE — routed lines answer them FIFO, none lost", async () => {
    const ch = createMidTurnApprovalChannel()
    const first = ch.awaitLine()
    const second = ch.awaitLine()
    expect(ch.tryResolve("y")).toBe(true)
    expect(await first).toEqual({ kind: "line", line: "y" })
    expect(ch.tryResolve("blue")).toBe(true)
    expect(await second).toEqual({ kind: "line", line: "blue" })
  })

  test("active defaults false (between turns ⇒ prompt uses its own readline)", () => {
    expect(createMidTurnApprovalChannel().active).toBe(false)
  })
})
