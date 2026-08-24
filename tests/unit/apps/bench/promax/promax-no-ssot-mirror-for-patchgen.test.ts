/**
 * PMX-04 — A PATCH-GEN-ONLY REPORT MUST NOT REACH THE LEADERBOARD.
 *
 * For a family that grades in its own grader phase, the bench report is written
 * by a pass with the grading shim OFF: every instance in it is an explicit
 * "requires the official Python harness — REFUSING to fake-grade" infra error, BY
 * CONSTRUCTION. Its verdicts are discarded — that is why `parseBoxGradeVerdicts`
 * exists at all.
 *
 * It was still mirrored to the canonical SSOT (`~/.quanta/bench/results`), which
 * is the leaderboard dashboard's first report root. The report carries
 * `datasetFamily: promax`, so it landed on the ProMax view: a campaign row whose
 * every instance is a measurement hole — and, until the grade receipt existed,
 * the ONLY ProMax artifact any dashboard would ever see.
 *
 * The dashboard does exclude those rows from its denominator (`grader_invalid` is
 * a re-runnable hole), so this is not a wrong PERCENTAGE. It is a wrong ARTIFACT:
 * the run's authoritative record is the pass-rate document and the grade receipt
 * beside it, both of which are saved. The report stays on disk as forensics; it
 * just stops claiming to be a result.
 */
import { describe, expect, test } from "bun:test"
import { shouldMirrorReportToSsot } from "@/apps/bench/remote/box-session/chunk-artifacts"

describe("the SSOT mirror is skipped for a patch-gen-only report", () => {
  test("🔴 a family that grades on-box does NOT mirror its bench report", () => {
    expect(shouldMirrorReportToSsot("promax")).toBe(false)
  })

  test("PAIRED CONTROL: every inline-grading family still mirrors", () => {
    for (const family of ["verified", "live", "pro"] as const) {
      expect(shouldMirrorReportToSsot(family), `${family} stopped mirroring`).toBe(true)
    }
  })

  test("the decision follows the PORT, not a family name", () => {
    // Packet invariant 10: no `family === "promax"` compare outside the profile.
    // A future on-box-grading family must inherit this without editing transport.
    const src = require("node:fs").readFileSync(
      "src/apps/bench/remote/box-session/chunk-artifacts.ts",
      "utf8",
    ) as string
    expect(src).not.toMatch(/===\s*"promax"/)
    expect(src).toContain("boxGrade")
  })
})
