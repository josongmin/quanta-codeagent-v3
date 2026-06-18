import { describe, expect, test } from "bun:test"
import { buildClosureSession } from "@/runner/batch/eval/closure-session"

describe("buildClosureSession", () => {
  test("issue-named file corroborates the stage1 owner and renders a closure hint", () => {
    const session = buildClosureSession({
      problemStatement: 'Fix `src/foo.py` so it returns "hello".',
      stage1Files: [{ file: "src/foo.py", score: 5 }],
      posture: { lspNav: false, primaryRail: false, faultEvidence: true },
    })
    expect(session.input.evidence.issueFiles).toContain("src/foo.py")
    expect(session.bundle.owner.admit).toBe(true)
    expect(session.closureHint).toBe("First edit candidate: src/foo.py")
  })

  test("owner-resolve seam is threaded into the closure bundle input when supplied", () => {
    const ownerResolved = [{ file: "src/foo.py", forSymbol: "foo" }] as const
    const session = buildClosureSession({
      problemStatement: "Fix foo in src/foo.py.",
      stage1Files: [{ file: "src/foo.py", score: 5 }],
      ownerResolved,
      posture: { lspNav: true, primaryRail: false, faultEvidence: false },
    })
    expect(session.input.evidence.ownerResolved).toEqual(ownerResolved)
  })
})
