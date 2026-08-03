/**
 * RFC06-4 (B5) — anchored review comments.
 *
 * A `ReviewFinding` may carry an `anchor {path,line,hunkId,beforeHash,afterHash}`
 * binding it to a REAL hunk of the diff the reviewer saw. `validateAnchoredFinding`
 * consumes the EXISTING `ReviewFinding` (with RFC09-2's verdict/category/
 * shortSummary) — it does NOT introduce a second finding schema. An anchor whose
 * `hunkId` is not in `splitHunks(before, after)`, or whose before/after hashes do
 * not match the diff, is marked `actionable:false` (honest anchoring, mirroring
 * the hunk-apply staleness rigor). Findings with no anchor are unchanged.
 */
import { describe, expect, it } from "bun:test"
import { splitHunks } from "@/runner/diff-ops"
import { sha256Hex } from "@/storage"
import { validateAnchoredFinding } from "@/tool/git/review-anchor"
import type { ReviewFinding } from "@/tool/git/review-diff"

const B = ["a", "b", "c", "d", "e"].join("\n")
const A = ["a", "B2", "c", "d", "E2"].join("\n")

const anchorFor = (hunkId: string): NonNullable<ReviewFinding["anchor"]> => ({
  path: "f.txt",
  line: 2,
  hunkId,
  beforeHash: sha256Hex(B),
  afterHash: sha256Hex(A),
})

describe("RFC06-4 — anchored review comment validation", () => {
  it("a finding anchored to a REAL hunk is actionable", () => {
    const ids = splitHunks(B, A).map((h) => h.id)
    expect(ids.length).toBeGreaterThanOrEqual(2)
    const finding: ReviewFinding = {
      file: "f.txt",
      severity: "warning",
      what: "x",
      anchor: anchorFor(ids[0] ?? "h1"),
    }
    const out = validateAnchoredFinding(finding, { path: "f.txt", before: B, after: A })
    expect(out.actionable).toBe(true)
    expect(out.finding.anchor?.hunkId).toBe(ids[0])
  })

  it("a finding anchored to a NON-EXISTENT hunk is non-actionable (dropped anchor honesty)", () => {
    const finding: ReviewFinding = {
      file: "f.txt",
      severity: "error",
      what: "y",
      anchor: anchorFor("h999"),
    }
    const out = validateAnchoredFinding(finding, { path: "f.txt", before: B, after: A })
    expect(out.actionable).toBe(false)
    expect(out.reason).toContain("hunk")
  })

  it("a stale before-hash makes the anchor non-actionable (the reviewer saw a different diff)", () => {
    const ids = splitHunks(B, A).map((h) => h.id)
    const finding: ReviewFinding = {
      file: "f.txt",
      severity: "warning",
      what: "z",
      anchor: { ...anchorFor(ids[0] ?? "h1"), beforeHash: sha256Hex("STALE") },
    }
    const out = validateAnchoredFinding(finding, { path: "f.txt", before: B, after: A })
    expect(out.actionable).toBe(false)
    expect(out.reason).toContain("hash")
  })

  it("a finding with NO anchor passes through unchanged and actionable (byte-identical old shape)", () => {
    const finding: ReviewFinding = { file: "f.txt", severity: "info", what: "note" }
    const out = validateAnchoredFinding(finding, { path: "f.txt", before: B, after: A })
    expect(out.actionable).toBe(true)
    expect(out.finding).toEqual(finding)
    expect(out.finding.anchor).toBeUndefined()
  })

  it("preserves the RFC09-2 verdict/category/shortSummary (no second finding schema)", () => {
    const ids = splitHunks(B, A).map((h) => h.id)
    const finding: ReviewFinding = {
      file: "f.txt",
      severity: "error",
      what: "leak",
      verdict: "confirmed",
      category: "resource-leak",
      shortSummary: "fd not closed",
      anchor: anchorFor(ids[0] ?? "h1"),
    }
    const out = validateAnchoredFinding(finding, { path: "f.txt", before: B, after: A })
    expect(out.actionable).toBe(true)
    expect(out.finding.verdict).toBe("confirmed")
    expect(out.finding.category).toBe("resource-leak")
    expect(out.finding.shortSummary).toBe("fd not closed")
  })
})
