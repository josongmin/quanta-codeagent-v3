/**
 * T-201 — fault-evidence bench adapter (render/assemble seam).
 *
 * Teeth: the rendered hint is BOUNDED (no raw file bodies), reflects ranking,
 * skips cleanly when empty, and surfaces the partial flag. A regression that
 * splats source content or renders an empty packet goes RED.
 */
import { describe, expect, test } from "bun:test"
import { assembleFaultEvidence, renderFaultEvidenceHint } from "@/runner/batch/eval/fault-evidence"

describe("fault-evidence adapter", () => {
  const packet = assembleFaultEvidence({
    issueText: "`Paginator.__iter__` over `page_range` in `django/core/paginator.py`",
    stage1Files: [
      { file: "django/core/paginator.py", score: 10 },
      { file: "django/core/x.py", score: 2 },
    ],
    issueFiles: ["django/core/paginator.py"],
    ownerResolved: [{ file: "django/core/paginator.py", forSymbol: "Paginator" }],
  })

  test("renders ranked owners with symbols, owner file first", () => {
    const hint = renderFaultEvidenceHint(packet)
    expect(hint).toContain("django/core/paginator.py")
    expect(hint).toContain("Paginator")
    expect(hint.indexOf("paginator.py")).toBeLessThan(hint.indexOf("x.py"))
  })

  test("never emits raw source bodies (only paths/symbols)", () => {
    const hint = renderFaultEvidenceHint(packet)
    // no diff/code-block/multi-line-body markers; bounded line-per-candidate
    expect(hint).not.toMatch(/```|def |class |@@ /)
    expect(hint).toStartWith("Likely fault owners")
    expect(hint.match(/^- /gm)?.length).toBe(2)
    expect(hint).toContain("Issue symbols: Paginator")
  })

  test("empty packet → empty string (caller skips injection)", () => {
    expect(renderFaultEvidenceHint(assembleFaultEvidence({ issueText: "" }))).toBe("")
  })

  test("partial evidence is surfaced in the hint", () => {
    const partial = assembleFaultEvidence({
      issueText: "fix `Foo.bar` in `a.py`",
      issueFiles: ["a.py"],
      // no stage1, no ownerResolved → partial
    })
    expect(renderFaultEvidenceHint(partial)).toContain("partial evidence")
  })
})
