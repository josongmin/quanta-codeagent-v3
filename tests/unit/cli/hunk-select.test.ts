/**
 * T05 — CLI hunk-selection helpers (pure parse + decision shaping). The
 * interactive askLine flow is exercised by the e2e-pty harness; here we pin the
 * PURE logic: parsing operator input into hunk ids and turning an executor
 * result into the ConfirmDecision the gate consumes.
 */
import { describe, expect, it } from "bun:test"
import {
  parseHunkSelection,
  renderHunkChoices,
  shapePartialDecision,
} from "../../../src/apps/cli/repl/hunk-select"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

const IDS = ["h1", "h2", "h3"]

describe("parseHunkSelection", () => {
  it("comma list maps numbers to hN ids", () => {
    expect(parseHunkSelection("1,3", IDS)).toEqual(["h1", "h3"])
  })
  it("space + comma mixed separators", () => {
    expect(parseHunkSelection("1, 2", IDS)).toEqual(["h1", "h2"])
  })
  it("ranges expand inclusively", () => {
    expect(parseHunkSelection("1-3", IDS)).toEqual(["h1", "h2", "h3"])
  })
  it("'all' / 'a' selects every id", () => {
    expect(parseHunkSelection("all", IDS)).toEqual(IDS)
    expect(parseHunkSelection("a", IDS)).toEqual(IDS)
  })
  it("'none' / 'n' / empty selects nothing", () => {
    expect(parseHunkSelection("none", IDS)).toEqual([])
    expect(parseHunkSelection("n", IDS)).toEqual([])
    expect(parseHunkSelection("", IDS)).toEqual([])
  })
  it("out-of-range / garbage tokens are dropped (never throws)", () => {
    expect(parseHunkSelection("1,99,foo,0,-2", IDS)).toEqual(["h1"])
  })
  it("dedupes and preserves diff order regardless of input order", () => {
    expect(parseHunkSelection("3,1,3,1", IDS)).toEqual(["h1", "h3"])
  })
})

describe("renderHunkChoices", () => {
  it("numbers each hunk and shows its +/- body", () => {
    setColorPolicy("on")
    const before = ["a", "b", "c", "d", "e"].join("\n")
    const after = ["a", "B", "c", "D", "e"].join("\n")
    const out = stripAnsi(renderHunkChoices(before, after))
    setColorPolicy("auto")
    expect(out).toContain("[1]")
    expect(out).toContain("[2]")
    expect(out).toContain("- b")
    expect(out).toContain("+ B")
  })
})

describe("shapePartialDecision", () => {
  it("applied → deny_and_steer naming accepted + rejected hunks", () => {
    const d = shapePartialDecision(
      { status: "applied", appliedHunkIds: ["h1"], content: "x" },
      ["h1"],
      ["h1", "h2"],
      "/f",
    )
    expect(d.decision).toBe("deny_and_steer")
    if (d.decision === "deny_and_steer") {
      expect(d.steer).toContain("/f")
      expect(d.steer).toContain("h1") // accepted
      expect(d.steer).toContain("h2") // rejected
    }
  })

  it("stale → deny_and_steer telling the model nothing was applied", () => {
    const d = shapePartialDecision(
      { status: "stale", reason: "file changed since preview (staleness guard)" },
      ["h1"],
      ["h1", "h2"],
      "/f",
    )
    expect(d.decision).toBe("deny_and_steer")
    if (d.decision === "deny_and_steer") {
      expect(d.steer.toLowerCase()).toContain("no")
      expect(d.steer.toLowerCase()).toContain("chang")
    }
  })

  it("error → deny_and_steer surfaces the failure (no false success)", () => {
    const d = shapePartialDecision(
      { status: "error", reason: "write failed: EACCES" },
      ["h1"],
      ["h1", "h2"],
      "/f",
    )
    expect(d.decision).toBe("deny_and_steer")
  })
})
