/**
 * T05 — CLI hunk-selection helpers (pure parse + decision shaping). The
 * interactive askLine flow is exercised by the e2e-pty harness; here we pin the
 * PURE logic: parsing operator input into hunk ids and turning an executor
 * result into the ConfirmDecision the gate consumes.
 */
import { afterEach, describe, expect, it } from "bun:test"
import {
  parseHunkSelection,
  parseHunkSelectionDetailed,
  renderHunkChoices,
  shapePartialDecision,
} from "../../../src/apps/cli/repl/hunk-select"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "../../../src/shared"
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
  it("a pathological huge range is clamped to the id count (no OOM/hang)", () => {
    const t0 = Date.now()
    // Indices beyond the id count are useless (the filter drops them); the parser
    // must NOT materialize a 10^9-entry Set. Result = every real id, computed fast.
    expect(parseHunkSelection("1-999999999", IDS)).toEqual(IDS)
    expect(Date.now() - t0).toBeLessThan(500)
  })
  it("a reversed / inverted range yields nothing (lo>hi, no underflow loop)", () => {
    expect(parseHunkSelection("3-1", IDS)).toEqual([])
  })
  it("dedupes and preserves diff order regardless of input order", () => {
    expect(parseHunkSelection("3,1,3,1", IDS)).toEqual(["h1", "h3"])
  })
})

/**
 * UUX-6-15 HELLGATE — the picker must not SILENTLY drop invalid tokens. The
 * pure detailed parse reports which tokens contributed nothing; the
 * back-compat `parseHunkSelection` wrapper (called from the LOCKED
 * runtime-context-compose picker) surfaces them as an "ignored: …" operator
 * notice. Selection semantics stay byte-identical (paired asserts below).
 */
describe("UUX-6-15 — parseHunkSelectionDetailed reports rejected tokens", () => {
  afterEach(() => {
    __resetOperatorNoticeSinkForTest()
  })

  it("non-numeric / out-of-range / zero tokens land in `ignored` (selection unchanged)", () => {
    const { selected, ignored } = parseHunkSelectionDetailed("1,99,foo,0,-2", IDS)
    expect(selected).toEqual(["h1"]) // identical to parseHunkSelection
    expect(ignored).toEqual(["99", "foo", "0", "-2"])
  })

  it("a fully-out-of-range or reversed range token is ignored; a partially-useful one is not", () => {
    expect(parseHunkSelectionDetailed("3-1", IDS).ignored).toEqual(["3-1"])
    expect(parseHunkSelectionDetailed("7-9", IDS).ignored).toEqual(["7-9"])
    // "1-999999999" still selects every id ⇒ it contributed ⇒ NOT reported.
    const huge = parseHunkSelectionDetailed("1-999999999", IDS)
    expect(huge.selected).toEqual(IDS)
    expect(huge.ignored).toEqual([])
  })

  it("valid-only input and the all/none fast paths report nothing", () => {
    expect(parseHunkSelectionDetailed("1,3", IDS).ignored).toEqual([])
    expect(parseHunkSelectionDetailed("all", IDS).ignored).toEqual([])
    expect(parseHunkSelectionDetailed("none", IDS).ignored).toEqual([])
    expect(parseHunkSelectionDetailed("", IDS).ignored).toEqual([])
  })

  it("parseHunkSelection (locked-caller seam) emits ONE 'ignored: …' notice for dropped tokens", () => {
    const seen: OperatorNotice[] = []
    installOperatorNoticeSink((n) => seen.push(n))
    expect(parseHunkSelection("1,99,foo", IDS)).toEqual(["h1"])
    expect(seen.length).toBe(1)
    const notice = seen[0] as OperatorNotice
    expect(notice.message).toContain("ignored: 99, foo")
    // Paired control — a fully-valid selection emits nothing.
    expect(parseHunkSelection("1,2", IDS)).toEqual(["h1", "h2"])
    expect(seen.length).toBe(1)
  })
})

describe("renderHunkChoices", () => {
  it("numbers each hunk and shows its +/- body", () => {
    setColorPolicy("on")
    const before = ["a", "b", "c", "d", "e"].join("\n")
    const after = ["a", "B", "c", "D", "e"].join("\n")
    const out = stripAnsi(renderHunkChoices(before, after))
    setColorPolicy(null)
    expect(out).toContain("[1]")
    expect(out).toContain("[2]")
    expect(out).toContain("- b")
    expect(out).toContain("+ B")
  })

  it("pure-deletion hunk renders only the removed line (no spurious + line)", () => {
    setColorPolicy("on")
    const before = ["a", "b", "c"].join("\n")
    const after = ["a", "c"].join("\n")
    const out = stripAnsi(renderHunkChoices(before, after))
    setColorPolicy(null)
    expect(out).toContain("[1]")
    expect(out).toContain("- b")
    expect(out).toContain("-1/+0") // delCount=1, addCount=0 in the header
    expect(out).not.toContain("+ ") // no added line for a pure deletion
  })

  it("pure-insertion hunk renders only the added line (no spurious - line)", () => {
    setColorPolicy("on")
    const before = ["a", "c"].join("\n")
    const after = ["a", "b", "c"].join("\n")
    const out = stripAnsi(renderHunkChoices(before, after))
    setColorPolicy(null)
    expect(out).toContain("+ b")
    expect(out).toContain("-0/+1")
    expect(out).not.toContain("- ") // no removed line for a pure insertion
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

  it("applied with ALL hunks accepted → 'rejected: none' (fmt none-branch)", () => {
    const d = shapePartialDecision(
      { status: "applied", appliedHunkIds: ["h1", "h2"], content: "x" },
      ["h1", "h2"],
      ["h1", "h2"],
      "/f",
    )
    expect(d.decision).toBe("deny_and_steer")
    if (d.decision === "deny_and_steer") {
      expect(d.steer).toContain("accepted: h1, h2")
      expect(d.steer).toContain("rejected: none")
    }
  })

  it("applied with ZERO hunks accepted → 'accepted: none' (fmt none-branch)", () => {
    const d = shapePartialDecision(
      { status: "applied", appliedHunkIds: [], content: "before" },
      [],
      ["h1", "h2"],
      "/f",
    )
    if (d.decision === "deny_and_steer") {
      expect(d.steer).toContain("accepted: none")
      expect(d.steer).toContain("rejected: h1, h2")
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
