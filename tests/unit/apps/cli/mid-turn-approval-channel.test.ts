/**
 * Mid-turn approval channel — the fix for "the approval input box never appeared
 * and it auto-denied" (a mid-turn approval fighting the in-turn keystroke reader
 * for stdin). These pin the routing contract.
 */
import { describe, expect, test } from "bun:test"
import { createMidTurnApprovalChannel } from "@/apps/cli/repl/mid-turn-approval-channel"

describe("mid-turn approval channel", () => {
  test("a captured line resolves a waiting approval (routed, not queued)", async () => {
    const ch = createMidTurnApprovalChannel()
    const answer = ch.awaitLine()
    expect(ch.tryResolve("y")).toBe(true) // consumed by the approval
    expect(await answer).toBe("y")
  })

  test("tryResolve returns false when no approval is pending (line falls through to follow-up routing)", () => {
    const ch = createMidTurnApprovalChannel()
    expect(ch.tryResolve("some follow-up")).toBe(false)
  })

  test("clear() releases a waiter with '' so a turn ending mid-approval denies (fail-closed)", async () => {
    const ch = createMidTurnApprovalChannel()
    const answer = ch.awaitLine()
    ch.clear()
    expect(await answer).toBe("") // "" ≠ "y" ⇒ the prompt treats it as deny
    expect(ch.tryResolve("late")).toBe(false) // already cleared
  })

  test("only ONE waiter at a time — a new awaitLine denies the stale one", async () => {
    const ch = createMidTurnApprovalChannel()
    const first = ch.awaitLine()
    const second = ch.awaitLine()
    expect(await first).toBe("") // stale waiter released as deny
    expect(ch.tryResolve("y")).toBe(true)
    expect(await second).toBe("y")
  })

  test("active defaults false (between turns ⇒ prompt uses its own readline)", () => {
    expect(createMidTurnApprovalChannel().active).toBe(false)
  })
})
