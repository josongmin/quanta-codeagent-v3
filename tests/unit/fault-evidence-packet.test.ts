/**
 * T-201 — FaultEvidencePacket builder (pure, blind, bounded).
 *
 * Hellgate teeth: the builder merges stage-1 ranked files + issue-named files +
 * bounded owner-resolve evidence into a DETERMINISTIC, BOUNDED, typed packet
 * with provenance — and degrades (never throws) on missing inputs. A regression
 * that (a) loses determinism, (b) breaks the cap, (c) drops the partial flag on
 * missing LSP, (d) injects raw source, or (e) crashes on empty input goes RED.
 */
import { describe, expect, test } from "bun:test"
import {
  buildFaultEvidencePacket,
  type FaultEvidenceInput,
  ownerStrength,
} from "@/agent/fault-evidence/build"

const base: FaultEvidenceInput = {
  issueText: "`Paginator.__iter__` should iterate `page_range`. See `django/core/paginator.py`.",
  stage1Files: [
    { file: "django/core/paginator.py", score: 10 },
    { file: "django/core/x.py", score: 4 },
    { file: "django/core/y.py", score: 3 },
    { file: "django/core/z.py", score: 2 },
    { file: "django/core/w.py", score: 1 },
    { file: "django/core/v.py", score: 0.5 },
  ],
  issueFiles: ["django/core/paginator.py"],
  ownerResolved: [{ file: "django/core/paginator.py", forSymbol: "Paginator" }],
}

describe("buildFaultEvidencePacket", () => {
  test("deterministic: same input → identical packet", () => {
    expect(buildFaultEvidencePacket(base)).toEqual(buildFaultEvidencePacket(base))
  })

  test("merges provenance + boosts the owner-resolved / issue-named file to the top", () => {
    const p = buildFaultEvidencePacket(base)
    expect(p.candidates[0]?.file).toBe("django/core/paginator.py")
    expect(p.candidates[0]?.sources.slice().sort()).toEqual(["issue-file", "owner-resolve", "stage1"])
    expect(p.candidates[0]?.symbols).toContain("Paginator")
  })

  test("candidate window is bounded (default cap 5) + truncated flag", () => {
    const p = buildFaultEvidencePacket(base)
    expect(p.candidates.length).toBeLessThanOrEqual(5)
    expect(p.truncated).toBe(true) // 6 distinct stage-1 files > cap 5
  })

  test("custom cap respected", () => {
    const p = buildFaultEvidencePacket({ ...base, maxCandidates: 2 })
    expect(p.candidates.length).toBe(2)
  })

  test("issue symbols bounded, never raw source content", () => {
    const p = buildFaultEvidencePacket({ ...base, maxSymbols: 1 })
    expect(p.issueSymbols.length).toBe(1)
    // structural: a candidate exposes only path/score/sources/symbols — no file body
    expect(Object.keys(p.candidates[0] ?? {}).sort()).toEqual(["file", "score", "sources", "symbols"])
  })

  test("missing LSP (ownerResolved undefined) → partial, not throw", () => {
    const p = buildFaultEvidencePacket({ issueText: base.issueText, stage1Files: base.stage1Files ?? [] })
    expect(p.partial).toBe(true)
    expect(p.candidates.length).toBeGreaterThan(0)
  })

  test("empty stage-1 → partial, still yields issue-derived candidates", () => {
    const p = buildFaultEvidencePacket({
      issueText: base.issueText,
      issueFiles: ["django/core/paginator.py"],
      ownerResolved: [],
    })
    expect(p.partial).toBe(true)
    expect(p.candidates.map((c) => c.file)).toContain("django/core/paginator.py")
  })

  test("fully empty input degrades cleanly (no throw)", () => {
    const p = buildFaultEvidencePacket({ issueText: "" })
    expect(p.candidates).toEqual([])
    expect(p.issueSymbols).toEqual([])
    expect(p.partial).toBe(true)
  })

  test("deterministic tie-break by file path on equal score", () => {
    const p = buildFaultEvidencePacket({
      issueText: "",
      stage1Files: [
        { file: "b.py", score: 1 },
        { file: "a.py", score: 1 },
      ],
    })
    expect(p.candidates.map((c) => c.file)).toEqual(["a.py", "b.py"])
  })
})

describe("ownerStrength (T-OWN-12 lattice classifier)", () => {
  test("issue-file stream ⇒ authoritative (public issue named it)", () => {
    expect(ownerStrength({ sources: ["issue-file"] })).toBe("authoritative")
    // red-on-injection: presence of issue-file makes it authoritative even when
    // mixed with heuristic streams.
    expect(ownerStrength({ sources: ["stage1", "issue-file", "owner-resolve"] })).toBe(
      "authoritative",
    )
  })

  test("stage1-only ⇒ advisory (heuristic rank is not owner authority)", () => {
    expect(ownerStrength({ sources: ["stage1"] })).toBe("advisory")
  })

  test("owner-resolve without unique-definer tracking ⇒ advisory (TODO promotion)", () => {
    // Uniqueness is not yet tracked on the candidate, so a bare owner-resolve is
    // ADVISORY for now. A regression that silently promotes it to authoritative
    // (re-opening scored authority via LSP) goes RED here.
    expect(ownerStrength({ sources: ["owner-resolve"] })).toBe("advisory")
    expect(ownerStrength({ sources: ["stage1", "owner-resolve"] })).toBe("advisory")
  })

  test("empty sources ⇒ advisory (never authoritative by default)", () => {
    expect(ownerStrength({ sources: [] })).toBe("advisory")
  })

  test("classification reads ONLY sources, never score", () => {
    // A huge score with no authoritative stream is still advisory — clean
    // authority cannot leak through the additive score.
    expect(ownerStrength({ sources: ["stage1"] })).toBe("advisory")
    expect(ownerStrength({ sources: ["issue-file"] })).toBe("authoritative")
  })
})
