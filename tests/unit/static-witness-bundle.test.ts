import { describe, expect, it } from "bun:test"
import {
  buildStaticWitnessBundle,
  type StaticWitnessBundle,
} from "@/runner/batch/eval/static-witness-bundle"

/** The exact closed shape: 9 fields, no more. Adding a reject/score field breaks this. */
const EXPECTED_KEYS = [
  "candidateFamilies",
  "candidateTests",
  "coChangeCandidates",
  "confidenceReason",
  "definitionSites",
  "ownerFamilies",
  "ownerFiles",
  "referenceSites",
  "truncated",
] as const

describe("buildStaticWitnessBundle — shape + closed authority surface", () => {
  it("emits EXACTLY the 9 listed fields and nothing else (no reject/score smuggling)", () => {
    const bundle = buildStaticWitnessBundle({ ownerFiles: ["a.py"] })
    expect(Object.keys(bundle).sort()).toEqual([...EXPECTED_KEYS])
    // mutation teeth: any of these would be an authority leak.
    for (const forbidden of [
      "reject",
      "veto",
      "admissible",
      "admissibility",
      "score",
      "weight",
      "verdict",
      "pass",
      "fail",
      "FAIL_TO_PASS",
      "PASS_TO_PASS",
      "test_patch",
    ]) {
      expect(bundle).not.toHaveProperty(forbidden)
    }
  })

  it("confidenceReason is a string, never a number a gate could consume", () => {
    const bundle = buildStaticWitnessBundle({ confidenceReason: "  lsp-def + 2 refs  " })
    expect(typeof bundle.confidenceReason).toBe("string")
    expect(bundle.confidenceReason).toBe("lsp-def + 2 refs")
  })
})

describe("buildStaticWitnessBundle — empty / absent evidence", () => {
  it("no args → empty bundle, not an error", () => {
    const bundle = buildStaticWitnessBundle()
    expect(bundle).toEqual({
      ownerFiles: [],
      ownerFamilies: [],
      definitionSites: [],
      referenceSites: [],
      coChangeCandidates: [],
      candidateTests: [],
      candidateFamilies: [],
      confidenceReason: "",
      truncated: false,
    })
  })

  it("empty arrays → empty lists (LSP-unavailable degrades to missing evidence, not reject)", () => {
    const bundle = buildStaticWitnessBundle({
      ownerFiles: [],
      definitionSites: [],
      referenceSites: [],
    })
    expect(bundle.ownerFiles).toEqual([])
    expect(bundle.definitionSites).toEqual([])
    expect(bundle.referenceSites).toEqual([])
    expect(bundle.truncated).toBe(false)
  })
})

describe("buildStaticWitnessBundle — dedup + stable ordering", () => {
  it("dedupes and stably (lexicographically) orders every list", () => {
    const bundle = buildStaticWitnessBundle({
      ownerFiles: ["pkg/b.py", "pkg/a.py", "pkg/b.py"],
      ownerFamilies: ["fam2", "fam1", "fam1"],
      definitionSites: ["z:1", "a:9", "z:1"],
      referenceSites: ["r/c.py", "r/a.py", "r/a.py", "r/b.py"],
      coChangeCandidates: ["cc2.py", "cc1.py", "cc2.py"],
      candidateTests: ["t/b_test.py", "t/a_test.py", "t/a_test.py"],
      candidateFamilies: ["g2", "g1", "g2"],
    })
    expect(bundle.ownerFiles).toEqual(["pkg/a.py", "pkg/b.py"])
    expect(bundle.ownerFamilies).toEqual(["fam1", "fam2"])
    expect(bundle.definitionSites).toEqual(["a:9", "z:1"])
    expect(bundle.referenceSites).toEqual(["r/a.py", "r/b.py", "r/c.py"])
    expect(bundle.coChangeCandidates).toEqual(["cc1.py", "cc2.py"])
    expect(bundle.candidateTests).toEqual(["t/a_test.py", "t/b_test.py"])
    expect(bundle.candidateFamilies).toEqual(["g1", "g2"])
  })

  it("ordering is independent of input order (deterministic regardless of gather order)", () => {
    const forward = buildStaticWitnessBundle({ referenceSites: ["a", "b", "c"] })
    const reverse = buildStaticWitnessBundle({ referenceSites: ["c", "b", "a"] })
    expect(forward.referenceSites).toEqual(reverse.referenceSites)
    expect(forward).toEqual(reverse)
  })

  it("trims whitespace and drops empty/blank entries (no phantom evidence)", () => {
    const bundle = buildStaticWitnessBundle({
      ownerFiles: ["  pkg/a.py  ", "", "   ", "pkg/a.py"],
    })
    expect(bundle.ownerFiles).toEqual(["pkg/a.py"])
  })
})

describe("buildStaticWitnessBundle — truncated flag is evidence, never a reject", () => {
  it("preserves truncated=true verbatim (find_references cap hit records truncation)", () => {
    const bundle = buildStaticWitnessBundle({
      referenceSites: ["r1.py", "r2.py"],
      truncated: true,
    })
    expect(bundle.truncated).toBe(true)
    // truncation does NOT empty out or invalidate the gathered evidence.
    expect(bundle.referenceSites).toEqual(["r1.py", "r2.py"])
  })

  it("truncated defaults to false and only true coerces (no truthy leakage)", () => {
    expect(buildStaticWitnessBundle({ truncated: false }).truncated).toBe(false)
    expect(buildStaticWitnessBundle({}).truncated).toBe(false)
    // mutation teeth: strict === true means non-boolean truthy never flips it.
    const sneaky = buildStaticWitnessBundle({
      truncated: 1 as unknown as boolean,
    })
    expect(sneaky.truncated).toBe(false)
  })
})

describe("buildStaticWitnessBundle — purity / no instance pattern-matching", () => {
  it("treats hidden-bench-label-shaped strings as opaque evidence, never specially", () => {
    // The bundle must NOT pattern-match instance labels; a path that happens to
    // contain 'test_patch' or 'FAIL_TO_PASS' is just a string carried verbatim.
    const bundle = buildStaticWitnessBundle({
      candidateTests: ["tests/test_patch_behavior.py", "tests/FAIL_TO_PASS_like.py"],
    })
    expect(bundle.candidateTests).toEqual([
      "tests/FAIL_TO_PASS_like.py",
      "tests/test_patch_behavior.py",
    ])
  })

  it("is referentially pure: same input → identical output across calls", () => {
    const args = { ownerFiles: ["a.py", "b.py"], truncated: true }
    const first: StaticWitnessBundle = buildStaticWitnessBundle(args)
    const second: StaticWitnessBundle = buildStaticWitnessBundle(args)
    expect(first).toEqual(second)
  })
})
