import { describe, expect, it } from "bun:test"
import type { ReproTestOutcome, ReproTestSample } from "@/agent/repro-test/types"
import { voteResolved } from "@/agent/repro-test/vote"

/** Build a minimal sample carrying only the field the vote reads. */
const s = (outcome: ReproTestOutcome): ReproTestSample => ({ source: "x", stdout: "", outcome })

describe("voteResolved — validation-time majority over the reproducing set", () => {
  it("THE FIX: a brittle minority does not sink a correct patch (3 resolved > 1 reproduced)", () => {
    const v = voteResolved([s("resolved"), s("resolved"), s("resolved"), s("reproduced")])
    expect(v.verdict).toBe("resolved")
    expect(v.resolved).toBe(3)
    expect(v.reproduced).toBe(1)
  })

  it("an incomplete patch is rejected (1 resolved < 3 reproduced)", () => {
    expect(voteResolved([s("resolved"), s("reproduced"), s("reproduced"), s("reproduced")]).verdict).toBe(
      "reproduced",
    )
  })

  it("RED-ON-INJECTION: flipping ONE resolved→reproduced turns a 3-1 win into a 2-2 tie (inconclusive)", () => {
    const win = voteResolved([s("resolved"), s("resolved"), s("resolved"), s("reproduced")])
    const flipped = voteResolved([s("resolved"), s("resolved"), s("reproduced"), s("reproduced")])
    expect(win.verdict).toBe("resolved")
    // The count genuinely drives the verdict — a single flip changes the answer.
    expect(flipped.verdict).toBe("inconclusive")
    expect(flipped.resolved).toBe(2)
    expect(flipped.reproduced).toBe(2)
  })

  it("inconclusive outcomes (other/exec_failed/unknown) do NOT count as 'still reproduced'", () => {
    // 1 resolved vs 0 reproduced, with 3 noisy crashes → resolved wins (crashes
    // must not be read as bug-present, else the false-NEGATIVE returns).
    const v = voteResolved([s("resolved"), s("other"), s("exec_failed"), s("unknown")])
    expect(v.verdict).toBe("resolved")
    expect(v.resolved).toBe(1)
    expect(v.reproduced).toBe(0)
    expect(v.inconclusive).toBe(3)
  })

  it("a tie is inconclusive (caller falls back to its legacy gate)", () => {
    expect(voteResolved([s("resolved"), s("reproduced")]).verdict).toBe("inconclusive")
  })

  it("empty input is inconclusive (0 decisive votes)", () => {
    const v = voteResolved([])
    expect(v.verdict).toBe("inconclusive")
    expect(v.resolved).toBe(0)
    expect(v.reproduced).toBe(0)
    expect(v.inconclusive).toBe(0)
  })

  it("all-inconclusive is inconclusive (never a silent pass or fail)", () => {
    expect(voteResolved([s("exec_failed"), s("other"), s("unknown")]).verdict).toBe("inconclusive")
  })
})
