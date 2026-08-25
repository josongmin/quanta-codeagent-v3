import { describe, expect, test } from "bun:test"
import { createTurnSubmitAuthority } from "@/sdk/runtime/session/turn-submit-authority"

describe("turn.submit host capability authority", () => {
  test("a capability is single-use and bound to objective id/revision", () => {
    const authority = createTurnSubmitAuthority()
    const issued = authority.issue({
      objectiveId: "goal-1",
      objectiveRevision: 4,
      validateCurrent: () => true,
    })
    expect(authority.consume(issued.provenance)).toBe(true)
    expect(authority.consume(issued.provenance)).toBe(false)
  })

  test("binding mismatch and current-authority drift both consume the token", () => {
    const authority = createTurnSubmitAuthority()
    const mismatch = authority.issue({
      objectiveId: "goal-1",
      objectiveRevision: 4,
      validateCurrent: () => true,
    })
    expect(authority.consume({ ...mismatch.provenance, objectiveRevision: 5 })).toBe(false)
    expect(authority.consume(mismatch.provenance)).toBe(false)

    const stale = authority.issue({
      objectiveId: "goal-1",
      objectiveRevision: 4,
      validateCurrent: () => false,
    })
    expect(authority.consume(stale.provenance)).toBe(false)
    expect(authority.consume(stale.provenance)).toBe(false)
  })
})
