/**
 * T05 per-hunk accept/reject — pure hunk decomposition + partial reconstruction.
 *
 * The HEART of the feature lives in `@/runner/diff-ops` (surface-agnostic, pure,
 * no I/O) per the spec ("hunk 분해를 diff-ops(pure)에"). Two functions:
 *   - splitHunks(before, after)        → atomic changed-runs with stable ids
 *   - applySelectedHunks(before, after, selectedIds) → partial content
 *
 * Strong-test discipline: every reconstruction is asserted by VALUE (not just
 * "is a string"), the round-trip invariants (all-selected === after, none ===
 * before) are paired controls, and hunk ids are asserted stable across calls.
 */
import { describe, expect, it } from "bun:test"
import { applySelectedHunks, diffOps, splitHunks } from "@/runner/diff-ops"

const B = ["line1", "line2", "line3", "line4", "line5", "line6", "line7"].join("\n")
// Three independent changes: line2 modified, line4 deleted, line6 modified.
const A = ["line1", "L2X", "line3", "line5", "L6X", "line7"].join("\n")

describe("splitHunks — atomic changed runs", () => {
  it("splits three separated changes into three hunks with stable ids", () => {
    const hunks = splitHunks(B, A)
    expect(hunks.length).toBe(3)
    expect(hunks.map((h) => h.id)).toEqual(["h1", "h2", "h3"])
    expect(hunks.map((h) => h.index)).toEqual([0, 1, 2])
    // ids are deterministic / stable across recomputation.
    expect(splitHunks(B, A).map((h) => h.id)).toEqual(["h1", "h2", "h3"])
  })

  it("a contiguous modify (del+add adjacent) is ONE hunk, not two", () => {
    const before = ["a", "b", "c"].join("\n")
    const after = ["a", "X", "c"].join("\n")
    const hunks = splitHunks(before, after)
    expect(hunks.length).toBe(1)
    const h = hunks[0]!
    expect(h.delCount).toBe(1)
    expect(h.addCount).toBe(1)
  })

  it("identical before/after yields zero hunks", () => {
    expect(splitHunks(B, B)).toEqual([])
  })

  it("pure insertion at EOF is one hunk (zero del, N add)", () => {
    const before = ["a", "b"].join("\n")
    const after = ["a", "b", "c", "d"].join("\n")
    const hunks = splitHunks(before, after)
    expect(hunks.length).toBe(1)
    expect(hunks[0]!.delCount).toBe(0)
    expect(hunks[0]!.addCount).toBe(2)
  })

  it("reports 1-based oldStart/newStart anchors", () => {
    const hunks = splitHunks(B, A)
    // h1 modifies line2 (old line 2, new line 2).
    expect(hunks[0]!.oldStart).toBe(2)
    expect(hunks[0]!.newStart).toBe(2)
  })
})

describe("applySelectedHunks — partial reconstruction", () => {
  it("selecting ALL hunks reconstructs exactly `after` (paired control vs none)", () => {
    const ids = splitHunks(B, A).map((h) => h.id)
    expect(applySelectedHunks(B, A, ids)).toBe(A)
    // none selected → exactly `before` (the opposite extreme).
    expect(applySelectedHunks(B, A, [])).toBe(B)
  })

  it("selecting ONLY h1 applies just the first change, leaves the rest at `before`", () => {
    const got = applySelectedHunks(B, A, ["h1"])
    // line2 modified; line4 still present (h2 not applied); line6 unchanged.
    expect(got).toBe(["line1", "L2X", "line3", "line4", "line5", "line6", "line7"].join("\n"))
  })

  it("selecting ONLY h2 (a deletion) drops line4 and nothing else", () => {
    const got = applySelectedHunks(B, A, ["h2"])
    expect(got).toBe(["line1", "line2", "line3", "line5", "line6", "line7"].join("\n"))
  })

  it("selecting h1 + h3 (skipping the middle deletion) composes correctly", () => {
    const got = applySelectedHunks(B, A, ["h1", "h3"])
    expect(got).toBe(["line1", "L2X", "line3", "line4", "line5", "L6X", "line7"].join("\n"))
  })

  it("unknown / duplicate ids are ignored (no throw, dedupe-safe)", () => {
    expect(applySelectedHunks(B, A, ["h1", "h1", "h99"])).toBe(
      applySelectedHunks(B, A, ["h1"]),
    )
  })

  it("empty before (new file) — selecting the sole hunk yields after, none yields empty", () => {
    const after = ["x", "y"].join("\n")
    const ids = splitHunks("", after).map((h) => h.id)
    expect(applySelectedHunks("", after, ids)).toBe(after)
    expect(applySelectedHunks("", after, [])).toBe("")
  })

  it("trailing-newline files round-trip (split/join inverse)", () => {
    const before = "a\nb\n"
    const after = "a\nB\n"
    const ids = splitHunks(before, after).map((h) => h.id)
    expect(applySelectedHunks(before, after, ids)).toBe(after)
    expect(applySelectedHunks(before, after, [])).toBe(before)
  })
})

describe("splitHunks ⟂ diffOps consistency", () => {
  it("every non-keep op belongs to exactly one hunk", () => {
    const ops = diffOps(B, A)
    const changed = ops.filter((o) => o.kind !== "keep").length
    const inHunks = splitHunks(B, A).reduce((n, h) => n + h.ops.length, 0)
    expect(inHunks).toBe(changed)
  })
})
