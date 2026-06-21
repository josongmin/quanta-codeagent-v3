import { describe, expect, it } from "bun:test"
import {
  buildCandidateFamilyBundleFromWitness,
  type CandidateFamily,
  type CandidateFamilyBundle,
  type CandidateFamilyId,
  candidateFamilyRank,
  planFamilyCoverage,
  planFamilyCoverageIds,
} from "@/runner/batch/eval/candidate-families"

/** Build a family with the given id and owner files (default: one owner). */
const family = (
  familyId: CandidateFamilyId,
  ownerFiles: readonly string[] = [`${familyId}.py`],
  over: Partial<CandidateFamily> = {},
): CandidateFamily => ({
  familyId,
  ownerFiles,
  reason: `${familyId} reason`,
  seed: `${familyId}-seed`,
  sourceEvidence: [`evidence:${familyId}`],
  ...over,
})

const bundleOf = (...families: CandidateFamily[]): CandidateFamilyBundle => ({ families })

describe("planFamilyCoverage — coverage guarantee (teeth)", () => {
  it("HELLGATE: root-owner is explored before symptom-owner is reused (n=2, one of EACH)", () => {
    // Symptom listed FIRST in the bundle to prove precedence — not bundle order —
    // protects the root family from being crowded out.
    const bundle = bundleOf(family("symptom-owner"), family("root-owner"))
    const ids = planFamilyCoverageIds(bundle, 2)

    // exactly one of each family before any reuse
    expect(ids).toHaveLength(2)
    expect([...ids].sort()).toEqual(["root-owner", "symptom-owner"])

    const rootIdx = ids.indexOf("root-owner")
    const firstSymptomIdx = ids.indexOf("symptom-owner")
    const lastSymptomIdx = ids.lastIndexOf("symptom-owner")
    // root-owner appears before symptom-owner is repeated (here: appears at all,
    // since symptom occurs exactly once — a monopoly would have emitted symptom twice).
    expect(rootIdx).toBeGreaterThanOrEqual(0)
    expect(rootIdx).toBeLessThan(firstSymptomIdx)
    expect(firstSymptomIdx).toBe(lastSymptomIdx) // symptom NOT repeated
  })

  it("symptom-owner cannot monopolize: with n bigger than family count, every family appears before any repeats", () => {
    const bundle = bundleOf(family("symptom-owner"), family("root-owner"), family("api-owner"))
    const ids = planFamilyCoverageIds(bundle, 5)
    // first 3 slots = one of each (the full non-empty set), only THEN reuse
    const firstPass = ids.slice(0, 3)
    expect([...firstPass].sort()).toEqual(["api-owner", "root-owner", "symptom-owner"])
    // symptom-owner does not reappear until pass 2
    expect(ids.indexOf("symptom-owner")).toBeLessThan(3)
    expect(ids).toHaveLength(5)
  })

  it("empty families are skipped — they never enter the plan", () => {
    const bundle = bundleOf(
      family("symptom-owner", []), // empty -> excluded
      family("root-owner"),
    )
    const ids = planFamilyCoverageIds(bundle, 3)
    expect(ids).toEqual(["root-owner", "root-owner", "root-owner"])
    expect(ids).not.toContain("symptom-owner")
  })
})

describe("planFamilyCoverage — deterministic ordering (teeth)", () => {
  it("fixed precedence: root, api, lifecycle, multi-site, symptom, test-adjacent regardless of bundle order", () => {
    const bundle = bundleOf(
      family("test-adjacent-owner"),
      family("symptom-owner"),
      family("multi-site"),
      family("lifecycle-owner"),
      family("api-owner"),
      family("root-owner"),
    )
    const ids = planFamilyCoverageIds(bundle, 6)
    expect(ids).toEqual([
      "root-owner",
      "api-owner",
      "lifecycle-owner",
      "multi-site",
      "symptom-owner",
      "test-adjacent-owner",
    ])
  })

  it("stable original order is the final tie-break among same-id families", () => {
    const a = family("root-owner", ["a.py"], { reason: "first" })
    const b = family("root-owner", ["b.py"], { reason: "second" })
    const bundle = bundleOf(a, b)
    const plan = planFamilyCoverage(bundle, 2)
    // same family id, so precedence ties -> original bundle order preserved.
    expect(plan.map((f) => f.reason)).toEqual(["first", "second"])
  })

  it("stable across repeated calls — deep-equal", () => {
    const bundle = bundleOf(
      family("symptom-owner"),
      family("root-owner"),
      family("test-adjacent-owner"),
    )
    const first = planFamilyCoverage(bundle, 7)
    const second = planFamilyCoverage(bundle, 7)
    expect(second).toEqual(first)
    // and the id projection is likewise stable
    expect(planFamilyCoverageIds(bundle, 7)).toEqual(planFamilyCoverageIds(bundle, 7))
  })
})

describe("candidate family witness builder — static symbol co-change", () => {
  it("builds a multi-site family from files sharing a public symbol witness", () => {
    const bundle = buildCandidateFamilyBundleFromWitness({
      rootOwnerFiles: ["pkg/base.py", "pkg/backend.py"],
      symbolOwners: [
        { file: "pkg/base.py", symbols: ["runshell"] },
        { file: "pkg/backend.py", symbols: ["runshell"] },
      ],
    })

    const multi = bundle?.families.find((f) => f.familyId === "multi-site")
    expect(multi?.ownerFiles).toEqual(["pkg/backend.py", "pkg/base.py"])
    expect(multi?.sourceEvidence).toEqual(["static-symbol-witness"])
  })

  it("does not invent a multi-site family from a single owner", () => {
    const bundle = buildCandidateFamilyBundleFromWitness({
      symbolOwners: [{ file: "pkg/base.py", symbols: ["runshell"] }],
    })
    expect(bundle).toBeUndefined()
  })
})

describe("candidateFamilyRank — family label has no authority unless touched", () => {
  it("multi-site rank requires touching every family file", () => {
    const multiSiteFamily = family("multi-site", ["pkg/base.py", "pkg/backend.py"])
    expect(candidateFamilyRank(multiSiteFamily, ["pkg/base.py"])).toBe(0)
    expect(candidateFamilyRank(multiSiteFamily, ["pkg/base.py", "pkg/backend.py"])).toBeGreaterThan(
      0,
    )
  })

  it("non-multi-site rank requires touching at least one family owner", () => {
    const rootFamily = family("root-owner", ["pkg/root.py"])
    expect(candidateFamilyRank(rootFamily, ["pkg/other.py"])).toBe(0)
    expect(candidateFamilyRank(rootFamily, ["pkg/root.py"])).toBeGreaterThan(0)
  })
})

describe("planFamilyCoverage — clean degradation (teeth)", () => {
  it("single family -> legacy single-family repetition up to n", () => {
    const bundle = bundleOf(family("root-owner"))
    expect(planFamilyCoverageIds(bundle, 4)).toEqual([
      "root-owner",
      "root-owner",
      "root-owner",
      "root-owner",
    ])
  })

  it("zero families -> empty plan", () => {
    expect(planFamilyCoverage(bundleOf(), 3)).toEqual([])
    expect(planFamilyCoverageIds(bundleOf(), 3)).toEqual([])
  })

  it("all families empty -> empty plan", () => {
    const bundle = bundleOf(family("root-owner", []), family("symptom-owner", []))
    expect(planFamilyCoverage(bundle, 5)).toEqual([])
  })

  it("n=0 / negative / non-finite -> empty plan", () => {
    const bundle = bundleOf(family("root-owner"), family("symptom-owner"))
    expect(planFamilyCoverage(bundle, 0)).toEqual([])
    expect(planFamilyCoverage(bundle, -3)).toEqual([])
    expect(planFamilyCoverage(bundle, Number.NaN)).toEqual([])
  })

  it("n=1 with multiple families -> only the top-precedence family (one slot)", () => {
    const bundle = bundleOf(family("symptom-owner"), family("root-owner"))
    expect(planFamilyCoverageIds(bundle, 1)).toEqual(["root-owner"])
  })

  it("non-integer n is floored", () => {
    const bundle = bundleOf(family("root-owner"), family("symptom-owner"))
    expect(planFamilyCoverageIds(bundle, 2.9)).toEqual(["root-owner", "symptom-owner"])
  })

  it("returns the actual family objects (provenance carried for telemetry)", () => {
    const root = family("root-owner")
    const plan = planFamilyCoverage(bundleOf(root), 1)
    expect(plan[0]).toBe(root)
    expect(plan[0]?.seed).toBe("root-owner-seed")
    expect(plan[0]?.sourceEvidence).toEqual(["evidence:root-owner"])
  })
})
