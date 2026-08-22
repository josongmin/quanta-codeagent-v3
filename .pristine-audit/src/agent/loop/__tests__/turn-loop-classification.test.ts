/**
 * FIX 2b + 2c (HELLGATE) — turn-loop observability classification.
 *
 * 2b: an approval-required PAUSE (SessionApprovalRequiredError) is an
 *     intentional HITL hand-off, not a hard error. `classifyTurnThrow` must
 *     label it "aborted" (span + flushKind) — NOT "error" — so it is not
 *     recorded as a run failure. Any other throw stays "error".
 * 2c: the park/gate SETTLE finish is a SYSTEM-originated interrupt (subagent
 *     wake), not a user Ctrl+C — `parkSettleFinish` must use the "system"
 *     interrupted category, not "user".
 */

import { describe, expect, test } from "bun:test"
import { STOP_REASON_CODE } from "../../stop-category"
import { classifyTurnThrow, parkSettleFinish } from "../turn-loop"

/** A minimal object matching `isSessionApprovalRequiredError`'s duck-type. */
const approvalError = () => ({
  approval: { approvalId: "a1", reason: "needs approval", requestedAt: 1 },
})

describe("classifyTurnThrow (FIX 2b)", () => {
  test("approval-required PAUSE ⇒ aborted span + aborted flushKind (NOT error)", () => {
    const c = classifyTurnThrow(approvalError())
    expect(c.turnSpanStatus).toBe("aborted")
    expect(c.flushKind).toBe("aborted")
  })

  test("a plain error throw stays error (byte-identical to prior behavior)", () => {
    const c = classifyTurnThrow(new Error("boom"))
    expect(c.turnSpanStatus).toBe("error")
    expect(c.flushKind).toBe("error")
  })

  test("a non-approval object throw stays error", () => {
    const c = classifyTurnThrow({ approval: { approvalId: "x" } /* missing fields */ })
    expect(c.turnSpanStatus).toBe("error")
    expect(c.flushKind).toBe("error")
  })
})

describe("parkSettleFinish (FIX 2c)", () => {
  test("settle finish is attributed to SYSTEM, not user", () => {
    const f = parkSettleFinish(4)
    expect(f.reason).toBe("aborted")
    expect(f.turns).toBe(4)
    expect(f.stopCategory.kind).toBe("interrupted")
    // the discriminating assertion: system.abort, NOT user.interrupt
    expect(f.stopCategory.reasonCode).toBe(STOP_REASON_CODE.SYSTEM_ABORT)
    expect(f.stopCategory.reasonCode).not.toBe(STOP_REASON_CODE.USER_INTERRUPT)
  })
})
