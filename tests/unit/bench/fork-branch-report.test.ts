/**
 * Hellgate — fork-branch report formatter (PURE).
 *
 * The formatter renders a deterministic, monospace-aligned comparison table for
 * K trajectory-fork experiment branches over one bench instance. Teeth pin the
 * exact bytes (snapshot), prove columns ALIGN regardless of name width, prove the
 * DIVERGED marker is meaningful (paired same/different control), prove reason
 * truncation is bounded (paired long/short), and that empty input degrades to a
 * sentinel instead of crashing.
 */
import { describe, expect, test } from "bun:test"
import {
  type ForkBranchOutcome,
  formatForkBranchReport,
  NO_BRANCHES,
} from "../../../src/apps/bench/eval/fork-branch-report"

describe("fork-branch report — deterministic table", () => {
  test("stable snapshot: a fixed 2-branch diverged input pins the exact bytes", () => {
    const out = formatForkBranchReport("astropy__astropy-12907", [
      { name: "baseline", passed: false, patchBytes: 0, turns: 8, reason: "empty patch" },
      { name: "inject", passed: true, patchBytes: 412, turns: 14 },
    ])
    expect(out).toBe(
      [
        "astropy__astropy-12907",
        "BRANCH    RESOLVED  PATCH(bytes)  TURNS  REASON",
        "baseline  no        0             8      empty patch",
        "inject    yes       412           14",
        "1/2 branches resolved — DIVERGED",
      ].join("\n"),
    )
  })

  test("determinism: same input → byte-identical output across calls", () => {
    const input: readonly ForkBranchOutcome[] = [
      { name: "a", passed: true, patchBytes: 10, turns: 3, reason: "ok" },
      { name: "b", passed: false, patchBytes: 0 },
    ]
    expect(formatForkBranchReport("inst", input)).toBe(formatForkBranchReport("inst", input))
  })

  test("ALIGNMENT teeth: a much longer branch name still lines up the RESOLVED column across rows", () => {
    const out = formatForkBranchReport("inst", [
      { name: "x", passed: true, patchBytes: 1, turns: 1 },
      { name: "a-very-long-experiment-branch-name", passed: false, patchBytes: 2, turns: 2 },
    ])
    const lines = out.split("\n")
    const header = lines[1] ?? ""
    const row1 = lines[2] ?? ""
    const row2 = lines[3] ?? ""

    // The header's RESOLVED column start index is the anchor.
    const col = header.indexOf("RESOLVED")
    expect(col).toBeGreaterThan(0)

    // Every data row's resolved token begins at exactly that index — i.e. the
    // short-name row was padded to the width of the long-name row.
    expect(row1.indexOf("yes")).toBe(col)
    expect(row2.indexOf("no")).toBe(col)

    // Discriminator: the long name itself sits in column 0 of its row, so the
    // alignment is real padding, not a coincidence of short content.
    expect(row2.startsWith("a-very-long-experiment-branch-name")).toBe(true)
  })

  test("DIVERGED discriminator (paired): differing outcomes mark DIVERGED; identical outcomes do NOT", () => {
    const diverged = formatForkBranchReport("inst", [
      { name: "a", passed: true, patchBytes: 1 },
      { name: "b", passed: false, patchBytes: 0 },
    ])
    expect(diverged).toContain("DIVERGED")

    // Paired control — same passed value on both branches: no marker.
    const agreedPass = formatForkBranchReport("inst", [
      { name: "a", passed: true, patchBytes: 1 },
      { name: "b", passed: true, patchBytes: 2 },
    ])
    expect(agreedPass).not.toContain("DIVERGED")
    expect(agreedPass).toContain("2/2 branches resolved")

    const agreedFail = formatForkBranchReport("inst", [
      { name: "a", passed: false, patchBytes: 0 },
      { name: "b", passed: false, patchBytes: 0 },
    ])
    expect(agreedFail).not.toContain("DIVERGED")
    expect(agreedFail).toContain("0/2 branches resolved")
  })

  test("reason truncation (paired): a >60-char reason is cut with the ellipsis marker; a short one is verbatim", () => {
    const long = "x".repeat(80)
    const outLong = formatForkBranchReport("inst", [
      { name: "a", passed: false, patchBytes: 0, reason: long },
    ])
    const longCell = outLong.split("\n")[2] ?? "" // single data row
    // The full 80-char reason must NOT appear verbatim...
    expect(longCell).not.toContain(long)
    // ...it is bounded to <= 60 visible reason chars and ends with the ellipsis.
    expect(longCell.endsWith("…")).toBe(true)
    // The reason segment (everything after the leading aligned columns) is the
    // truncated reason of exactly 60 chars: 59 x's + ellipsis.
    expect(longCell).toContain(`${"x".repeat(59)}…`)
    expect(longCell).not.toContain("x".repeat(60))

    // Paired control — a short reason survives byte-for-byte with no ellipsis.
    const short = "real fix"
    const outShort = formatForkBranchReport("inst", [
      { name: "a", passed: true, patchBytes: 9, reason: short },
    ])
    expect(outShort).toContain(short)
    expect(outShort).not.toContain("…")
  })

  test("empty branches → the (no branches) sentinel, no throw", () => {
    const out = formatForkBranchReport("inst-id", [])
    expect(out).toContain(NO_BRANCHES)
    expect(out).toBe(`inst-id\n${NO_BRANCHES}`)
  })

  test("summary count correctness: 1 of 3 passed → '1/3'", () => {
    const out = formatForkBranchReport("inst", [
      { name: "a", passed: false, patchBytes: 0 },
      { name: "b", passed: true, patchBytes: 5 },
      { name: "c", passed: false, patchBytes: 0 },
    ])
    expect(out).toContain("1/3 branches resolved")
    expect(out).toContain("DIVERGED") // 1 of 3 ⇒ outcomes differ
  })
})
