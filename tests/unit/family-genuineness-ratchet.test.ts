/**
 * Genuineness ratchet for clean candidate-family generation (T-GEN-09).
 *
 * THE RULE: no unvalidated heuristic / scored owner may drive selection. The
 * clean family tier is only allowed to rest on GENUINE public/static evidence —
 * specifically a `multi-site` family (a symbol the PUBLIC ISSUE names that is
 * defined across ≥2 files). The heuristic-scored localizer owners must NEVER be
 * promoted into a `root-owner` (or any) family in the clean selection path.
 *
 * This locks the audited invariant: `buildSelectionCandidateFamilyBundle` does
 * NOT pass `rootOwnerFiles`, so heuristic owners cannot become a family. If a
 * future edit pipes scored owners in, this goes RED.
 */
import { describe, expect, it } from "bun:test"
import {
  buildSelectionCandidateFamilyBundle,
  withCandidateFamilyPublicContracts,
} from "@/runner/batch/eval/driver"

const pyDef = (name: string): string => `def ${name}(x):\n    return x\n`

describe("clean family generation is genuine, not heuristic (T-GEN-09 ratchet)", () => {
  it("builds a multi-site family ONLY from an issue-named symbol defined across ≥2 files", () => {
    const bundle = buildSelectionCandidateFamilyBundle({
      problemStatement: "the target_fn helper returns the wrong value",
      ownerCandidates: ["pkg/a.py", "pkg/b.py"],
      ownerResolved: undefined,
      readSource: (f) => (f === "pkg/a.py" || f === "pkg/b.py" ? pyDef("target_fn") : null),
    })
    expect(bundle).not.toBeUndefined()
    // every produced family is multi-site — NO heuristic root-owner family.
    expect(bundle?.families.every((fam) => fam.familyId === "multi-site")).toBe(true)
    const ms = bundle?.families.find((fam) => fam.familyId === "multi-site")
    expect([...(ms?.ownerFiles ?? [])].sort()).toEqual(["pkg/a.py", "pkg/b.py"])
  })

  it("RED-ON-INJECTION: heuristic owners NEVER become a root-owner family in the clean path", () => {
    // Many ranked owner candidates, but NONE define an issue-named symbol shared
    // across files ⇒ no genuine family ⇒ bundle is undefined (the scored owners
    // are NOT promoted into a root-owner / any family).
    const bundle = buildSelectionCandidateFamilyBundle({
      problemStatement: "something is broken",
      ownerCandidates: ["pkg/x.py", "pkg/y.py", "pkg/z.py"],
      ownerResolved: undefined,
      readSource: (f) => pyDef(`unrelated_${f.replace(/\W/g, "")}`),
    })
    expect(bundle).toBeUndefined()
  })

  it("a single issue-named definer (no co-change) yields NO multi-site family (needs ≥2)", () => {
    const bundle = buildSelectionCandidateFamilyBundle({
      problemStatement: "fix the lonely_fn behavior",
      ownerCandidates: ["pkg/only.py"],
      ownerResolved: undefined,
      readSource: () => pyDef("lonely_fn"),
    })
    expect(bundle).toBeUndefined()
  })

  it("NO clean family kind other than multi-site is ever produced by the witness path", () => {
    const bundle = buildSelectionCandidateFamilyBundle({
      problemStatement: "the shared_sym spans backends",
      ownerCandidates: ["pkg/p.py", "pkg/q.py"],
      ownerResolved: undefined,
      readSource: () => pyDef("shared_sym"),
    })
    const kinds = new Set((bundle?.families ?? []).map((fam) => fam.familyId))
    expect([...kinds]).toEqual(["multi-site"])
    expect(kinds.has("root-owner")).toBe(false)
  })

  it("multi-site family stays advisory-only and does not mint a required public contract", () => {
    const bundle = buildSelectionCandidateFamilyBundle({
      problemStatement: "the shared_sym spans backends",
      ownerCandidates: ["pkg/p.py", "pkg/q.py"],
      ownerResolved: undefined,
      readSource: () => pyDef("shared_sym"),
    })
    const contracts = withCandidateFamilyPublicContracts(undefined, bundle)

    expect(bundle?.families).toHaveLength(1)
    expect(bundle?.families[0]?.familyId).toBe("multi-site")
    expect(contracts).toBeUndefined()
  })
})
