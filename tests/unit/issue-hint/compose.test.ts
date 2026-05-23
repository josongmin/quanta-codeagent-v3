/**
 * `composeIssueHint` — markdown formatter contract.
 *
 *   - empty hint ⇒ "" (sentinel: byte-identical pass-through at the seam)
 *   - non-empty ⇒ self-contained markdown block ending with the calibration
 *     line "Use these as starting points but verify with your own tools."
 */
import { describe, expect, test } from "bun:test"
import { composeIssueHint } from "../../../src/agent/issue-hint/compose"
import { EMPTY_HINT, type IssueHint } from "../../../src/agent/issue-hint/types"

describe("composeIssueHint — markdown format contract", () => {
  test("empty hint → empty string (byte-identical sentinel)", () => {
    expect(composeIssueHint(EMPTY_HINT)).toBe("")
    // Same shape but freshly built
    expect(
      composeIssueHint({
        files: [],
        symbols: [],
        errors: [],
        codeFences: [],
        tracebackPaths: [],
      }),
    ).toBe("")
  })

  test("files-only hint → header + Likely files line + calibration footer", () => {
    const out = composeIssueHint({
      files: ["a/b.py"],
      symbols: [],
      errors: [],
      codeFences: [],
      tracebackPaths: [],
    })
    expect(out).toContain("## Issue Hints (auto-extracted)")
    expect(out).toContain("- Likely files: `a/b.py`")
    expect(out).toContain("Use these as starting points but verify with your own tools.")
    // No bogus sections
    expect(out).not.toContain("Symbols mentioned")
    expect(out).not.toContain("Errors referenced")
    expect(out).not.toContain("Traceback locations")
    expect(out).not.toContain("Code blocks present")
  })

  test("all fields populated → all sections present, calibration last", () => {
    const h: IssueHint = {
      files: ["a/b.py", "c/d.py"],
      symbols: ["foo", "Bar"],
      errors: ["TypeError"],
      codeFences: ["block-1", "block-2"],
      tracebackPaths: ["a/b.py:10"],
    }
    const out = composeIssueHint(h)
    expect(out).toContain("- Likely files: `a/b.py`, `c/d.py`")
    expect(out).toContain("- Symbols mentioned: `foo`, `Bar`")
    expect(out).toContain("- Errors referenced: `TypeError`")
    expect(out).toContain("- Traceback locations: `a/b.py:10`")
    expect(out).toContain("- Code blocks present: 2")
    // Calibration line ALWAYS last non-empty line
    const trimmed = out.replace(/\s+$/g, "")
    expect(trimmed.endsWith("Use these as starting points but verify with your own tools.")).toBe(
      true,
    )
  })

  test("single code fence → singular 'block' noun", () => {
    const out = composeIssueHint({
      files: [],
      symbols: [],
      errors: [],
      codeFences: ["only one"],
      tracebackPaths: [],
    })
    expect(out).toContain("- Code block present: 1")
    expect(out).not.toContain("Code blocks present")
  })

  test("compose preserves array order (extractors sort; composer renders)", () => {
    // Composer does NOT re-sort — it trusts the input order. Test that the
    // exact extractor-produced order is rendered.
    const out = composeIssueHint({
      files: ["z.py", "a.py"], // intentionally NOT sorted
      symbols: [],
      errors: [],
      codeFences: [],
      tracebackPaths: [],
    })
    // We render literally; no resort.
    const idxZ = out.indexOf("z.py")
    const idxA = out.indexOf("a.py")
    expect(idxZ).toBeGreaterThan(-1)
    expect(idxA).toBeGreaterThan(-1)
    expect(idxZ).toBeLessThan(idxA)
  })

  test("backtick-fenced identifier list (escape sanity)", () => {
    const out = composeIssueHint({
      files: [],
      symbols: ["prepare_url"],
      errors: [],
      codeFences: [],
      tracebackPaths: [],
    })
    // Single-backtick fencing — name is wrapped clean.
    expect(out).toContain("`prepare_url`")
  })
})
