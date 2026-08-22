/**
 * SCAFF-04 hellgate: AST static witnesses become typed candidate families that
 * FORCE co-change coverage during generation, and an incomplete single-site
 * candidate earns NO family rank for a co-change family. Authoritative-only.
 */
import { describe, expect, it } from "bun:test"
import {
  candidateFamilyRank,
  staticWitnessesToFamilies,
  withStaticWitnessFamilies,
} from "@/runner/batch/eval/candidate-families"
import { makeStaticWitness } from "@/runner/batch/eval/static-witness"

const A = "pkg/base/client.py"
const B = "pkg/postgres/client.py"

const overrideWitness = makeStaticWitness({
  kind: "override-family",
  authority: "authoritative",
  provenance: "ast",
  subjectFiles: [A, B],
  subjectSymbols: ["settings_to_cmd_args_env"],
  reason: "method overridden across owner files",
})

describe("SCAFF-04 — static witnesses → typed candidate families", () => {
  it("an AUTHORITATIVE 2-file override-family witness becomes an override-family family", () => {
    const fams = staticWitnessesToFamilies([overrideWitness])
    expect(fams).toHaveLength(1)
    expect(fams[0]?.familyId).toBe("override-family")
    expect([...(fams[0]?.ownerFiles ?? [])].sort()).toEqual([A, B])
  })

  it("co-change family rank requires touching EVERY file (single-site = 0, complete = 1)", () => {
    const fam = staticWitnessesToFamilies([overrideWitness])[0]
    expect(candidateFamilyRank(fam, [A])).toBe(0) // single-site incomplete
    expect(candidateFamilyRank(fam, [B])).toBe(0)
    expect(candidateFamilyRank(fam, [A, B])).toBe(1) // complete co-change
  })

  it("RED-ON-INJECTION: an ADVISORY witness produces NO family (no fake authority)", () => {
    const advisory = makeStaticWitness({
      kind: "override-family",
      authority: "advisory",
      provenance: "ast",
      subjectFiles: [A, B],
      subjectSymbols: ["x"],
      reason: "ripgrep sibling, not structurally proven",
    })
    expect(staticWitnessesToFamilies([advisory])).toEqual([])
  })

  it("a 1-file override-family witness yields NO family (co-change needs >=2)", () => {
    const single = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "ast",
      subjectFiles: [A],
      subjectSymbols: ["x"],
      reason: "only one file",
    })
    expect(staticWitnessesToFamilies([single])).toEqual([])
  })

  it("withStaticWitnessFamilies merges witness families into an existing bundle", () => {
    const merged = withStaticWitnessFamilies(undefined, [overrideWitness])
    expect(merged?.families.some((f) => f.familyId === "override-family")).toBe(true)
  })
})
