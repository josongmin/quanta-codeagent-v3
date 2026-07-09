/**
 * ★ HELLGATE — WS-A (jul-10 uiux structural, UUX-1-22 / UUX-3-11): a released
 *   mid-turn prompt must be TYPED, never a silent deny disguised as input.
 *
 * Pinned bug: `MidTurnApprovalChannel.clear()` resolved a pending waiter with
 * the bare string `""` — indistinguishable from the operator pressing Enter on
 * an empty line. Turn cancel (Esc-Esc), Ctrl+B backgrounding, and normal turn
 * teardown all silently became "operator denied" with zero attribution.
 *
 * Contract under test:
 *   - `awaitLine()` resolves a DISCRIMINATED result: `{kind:"line", line}` for
 *     real operator input vs `{kind:"released", cause}` for a channel release.
 *   - `clear(cause)` REQUIRES a cause ("turn_teardown" — the compile-time
 *     signature change is itself the regression fence).
 *   - a superseded waiter (double awaitLine — wiring bug) releases the stale
 *     one with cause "superseded", never a fake empty line.
 */
import { describe, expect, test } from "bun:test"
import { createMidTurnApprovalChannel } from "../mid-turn-approval-channel"

describe("HELLGATE WS-A — mid-turn channel typed release", () => {
  test("a real operator line resolves {kind:'line'} (paired control)", async () => {
    const ch = createMidTurnApprovalChannel()
    const p = ch.awaitLine()
    expect(ch.tryResolve("y")).toBe(true)
    expect(await p).toEqual({ kind: "line", line: "y" })
  })

  test("an operator EMPTY line is a line, NOT a release (the shapes must differ)", async () => {
    const ch = createMidTurnApprovalChannel()
    const p = ch.awaitLine()
    ch.tryResolve("")
    expect(await p).toEqual({ kind: "line", line: "" })
  })

  test("clear('turn_teardown') resolves the waiter as a TYPED release", async () => {
    const ch = createMidTurnApprovalChannel()
    const p = ch.awaitLine()
    ch.clear("turn_teardown")
    expect(await p).toEqual({ kind: "released", cause: "turn_teardown" })
  })

  test("a superseding awaitLine releases the stale waiter with cause 'superseded'", async () => {
    const ch = createMidTurnApprovalChannel()
    const stale = ch.awaitLine()
    const fresh = ch.awaitLine()
    expect(await stale).toEqual({ kind: "released", cause: "superseded" })
    ch.tryResolve("ok")
    expect(await fresh).toEqual({ kind: "line", line: "ok" })
  })

  test("clear with nothing pending is a no-op; a later waiter is unaffected", async () => {
    const ch = createMidTurnApprovalChannel()
    ch.clear("turn_teardown")
    const p = ch.awaitLine()
    ch.tryResolve("later")
    expect(await p).toEqual({ kind: "line", line: "later" })
  })

  test("tryResolve after a release is NOT consumed (the waiter is gone)", async () => {
    const ch = createMidTurnApprovalChannel()
    const p = ch.awaitLine()
    ch.clear("turn_teardown")
    await p
    expect(ch.tryResolve("stray")).toBe(false)
  })
})
