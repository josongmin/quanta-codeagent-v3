/**
 * T-OWN-12 ACTIVATION hellgate. The driver now passes `ownerClean: selectorMode
 * === "clean"` into buildClosureSession, so clean presets use the rule-based
 * AUTHORITATIVE admission (issue-named owners only) instead of the additive
 * heuristic score/lead-gap. This locks the switch: same evidence, opposite
 * admission depending on `ownerClean`, and research (omitted) stays scored.
 */
import { describe, expect, it } from "bun:test"
import { buildClosureSession } from "@/runner/batch/eval/closure-session"

const posture = { lspNav: true, primaryRail: false, faultEvidence: true }

describe("T-OWN-12 activation: ownerClean switches owner admission", () => {
  it("LEGACY (ownerClean omitted): a corroborated NON-issue-named owner IS admitted (scored path)", () => {
    const s = buildClosureSession({
      problemStatement: "the foo helper returns the wrong value",
      stage1Files: [{ file: "pkg/a.py", score: 5 }],
      ownerResolved: [{ file: "pkg/a.py", forSymbol: "foo" }],
      posture,
    })
    // stage1 + owner-resolve = corroborated, clear lead ⇒ legacy admits.
    expect(s.bundle.owner.admit).toBe(true)
    expect(s.bundle.owner.owner).toBe("pkg/a.py")
  })

  it("CLEAN (ownerClean=true): the SAME owner is NOT admitted — it is not AUTHORITATIVE (no issue-file source)", () => {
    const s = buildClosureSession({
      problemStatement: "the foo helper returns the wrong value",
      stage1Files: [{ file: "pkg/a.py", score: 5 }],
      ownerResolved: [{ file: "pkg/a.py", forSymbol: "foo" }],
      posture,
      ownerClean: true,
    })
    // no authoritative (issue-named) owner ⇒ rule-based clean admission refuses.
    expect(s.bundle.owner.admit).toBe(false)
  })

  it("CLEAN: an ISSUE-NAMED owner IS admitted (exactly one authoritative owner)", () => {
    const s = buildClosureSession({
      problemStatement: "bug in pkg/a.py output",
      stage1Files: [{ file: "pkg/a.py", score: 5 }],
      issueFiles: ["pkg/a.py"],
      posture,
      ownerClean: true,
    })
    expect(s.bundle.owner.admit).toBe(true)
    expect(s.bundle.owner.owner).toBe("pkg/a.py")
  })
})
