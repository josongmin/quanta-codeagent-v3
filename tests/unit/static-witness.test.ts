import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "bun:test"
import {
  canBeCleanAuthority,
  canBeMultiSiteObligation,
  dedupeWitnesses,
  isCleanAuthorityProvenance,
  makeStaticWitness,
  STATIC_WITNESS_FORBIDDEN_PROVENANCE,
  type StaticWitness,
  type StaticWitnessProvenance,
} from "@/runner/batch/eval/static-witness"

const THIS_FILE = fileURLToPath(import.meta.url)
const MODULE_FILE = THIS_FILE.replace(
  "/tests/unit/static-witness.test.ts",
  "/src/runner/batch/eval/static-witness.ts",
)

describe("static-witness self-policing (forbidden literals)", () => {
  // Needles are assembled from fragments so this test's OWN source carries no full
  // forbidden literal — otherwise the scan below would (correctly) flag itself.
  const forbiddenNeedles: string[] = [
    "django" + "__",
    "astropy" + "__",
    "pytest-dev" + "__",
    "FAIL" + "_TO_" + "PASS",
    "PASS" + "_TO_" + "PASS",
    // a known gold/grader file-path literal shape
    "gold" + "-patch",
  ]

  it("neither the module source nor this test source contains a benchmark/gold literal", () => {
    const moduleSrc = readFileSync(MODULE_FILE, "utf8")
    const testSrc = readFileSync(THIS_FILE, "utf8")
    // The module is allowed to NAME forbidden provenance values inside its forbidden
    // set (that IS its job), so the gold/F2P/P2P-shaped grader literals are what we
    // forbid in the test body; benchmark instance prefixes are forbidden in BOTH.
    const benchPrefixes = ["django" + "__", "astropy" + "__", "pytest-dev" + "__"]
    for (const needle of benchPrefixes) {
      expect(moduleSrc.includes(needle)).toBe(false)
      expect(testSrc.includes(needle)).toBe(false)
    }
    // This test file must not hardcode raw grader keys / gold file literals either.
    // (We scan with the assembled needles, which themselves never appear verbatim.)
    const graderNeedles = forbiddenNeedles.filter((n) => !benchPrefixes.includes(n))
    for (const needle of graderNeedles) {
      // Count verbatim occurrences; assembled-fragment expressions don't match.
      const occurrences = testSrc.split(needle).length - 1
      expect(occurrences).toBe(0)
    }
  })
})

describe("makeStaticWitness", () => {
  it("normalizes subjectFiles/symbols (trim/dedup/stable-sort) deterministically", () => {
    const w = makeStaticWitness({
      kind: "producer-consumer",
      authority: "advisory",
      provenance: "ast",
      subjectFiles: ["  b/y.py ", "a/x.py", "a/x.py", "   ", "b/y.py"],
      subjectSymbols: ["zeta", "alpha", " alpha ", ""],
      reason: "shared symbol",
    })
    expect(w.subjectFiles).toEqual(["a/x.py", "b/y.py"])
    expect(w.subjectSymbols).toEqual(["alpha", "zeta"])
  })

  it("produces a STABLE id: shuffled+dup+whitespace input → equal id on rebuild", () => {
    const build = (files: string[], symbols: string[]): StaticWitness =>
      makeStaticWitness({
        kind: "override-family",
        authority: "advisory",
        provenance: "static-engine",
        subjectFiles: files,
        subjectSymbols: symbols,
        fromFile: "  base.py ",
        reason: "family",
      })
    const a = build(["b.py", "a.py", "a.py", "  c.py "], ["s2", "s1", " s1 "])
    const b = build(["  c.py", "a.py", "b.py", "b.py "], [" s1 ", "s2"])
    expect(a.witnessId).toBe(b.witnessId)
    expect(a.fromFile).toBe("base.py")
  })

  it("rejects an authoritative owner/family witness with EMPTY subjectFiles", () => {
    expect(() =>
      makeStaticWitness({
        kind: "override-family",
        authority: "authoritative",
        provenance: "static-engine",
        subjectFiles: ["   ", ""],
        reason: "no files is meaningless",
      }),
    ).toThrow()
    // paired control: advisory with no files is allowed (not an obligation).
    expect(() =>
      makeStaticWitness({
        kind: "override-family",
        authority: "advisory",
        provenance: "static-engine",
        subjectFiles: [],
        reason: "advisory ok",
      }),
    ).not.toThrow()
    // paired control: authoritative NON-owner/family kind with no files is allowed.
    expect(() =>
      makeStaticWitness({
        kind: "producer-consumer",
        authority: "authoritative",
        provenance: "ast",
        subjectFiles: [],
        subjectSymbols: ["sym"],
        reason: "symbol-only relation",
      }),
    ).not.toThrow()
  })

  it("carries path/symbol NAMES only — there is no raw-source-text field (no-source-body invariant)", () => {
    const w = makeStaticWitness({
      kind: "unique-symbol-definer",
      authority: "authoritative",
      provenance: "lsp",
      subjectFiles: ["pkg/mod.py"],
      subjectSymbols: ["Widget"],
      fromFile: "pkg/caller.py",
      reason: "unique definer",
    })
    const keys = Object.keys(w)
    const forbiddenFieldFragments = ["source", "body", "text", "content", "snippet", "code"]
    for (const key of keys) {
      for (const frag of forbiddenFieldFragments) {
        expect(key.toLowerCase().includes(frag)).toBe(false)
      }
    }
    expect(keys.sort()).toEqual(
      [
        "authority",
        "fromFile",
        "kind",
        "provenance",
        "reason",
        "subjectFiles",
        "subjectSymbols",
        "witnessId",
      ].sort(),
    )
  })
})

describe("canBeCleanAuthority", () => {
  const cleanArgs = {
    kind: "override-family" as const,
    authority: "authoritative" as const,
    provenance: "static-engine" as StaticWitnessProvenance,
    subjectFiles: ["a.py", "b.py"],
    reason: "r",
  }

  it("true for authoritative + allowed provenance + non-empty owner/family files", () => {
    expect(canBeCleanAuthority(makeStaticWitness(cleanArgs))).toBe(true)
  })

  it("false for advisory authority (paired control)", () => {
    expect(canBeCleanAuthority(makeStaticWitness({ ...cleanArgs, authority: "advisory" }))).toBe(
      false,
    )
  })

  it("false for a forbidden/unknown provenance string cast through the type", () => {
    // Cast an unknown grader-shaped provenance past the type to prove fail-closed.
    const forbidden = "gold" + "-patch"
    expect(STATIC_WITNESS_FORBIDDEN_PROVENANCE.has(forbidden)).toBe(true)
    const witness = makeStaticWitness({
      ...cleanArgs,
      provenance: forbidden as unknown as StaticWitnessProvenance,
    })
    expect(canBeCleanAuthority(witness)).toBe(false)
    expect(isCleanAuthorityProvenance(forbidden)).toBe(false)
    // also an entirely unknown string is not clean authority
    expect(isCleanAuthorityProvenance("totally-made-up")).toBe(false)
  })
})

describe("canBeMultiSiteObligation", () => {
  it("false for a 1-file witness, true for a 2-file witness", () => {
    const one = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "static-engine",
      subjectFiles: ["only.py"],
      reason: "single",
    })
    const two = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "static-engine",
      subjectFiles: ["a.py", "b.py"],
      reason: "pair",
    })
    expect(canBeMultiSiteObligation(one)).toBe(false)
    expect(canBeMultiSiteObligation(two)).toBe(true)
  })
})

describe("dedupeWitnesses", () => {
  it("collapses same kind+subjects to ONE stable id, preserving first-seen order", () => {
    const make = (reason: string): StaticWitness =>
      makeStaticWitness({
        kind: "lifecycle-owner",
        authority: "authoritative",
        provenance: "repo-map",
        subjectFiles: ["b.py", "a.py"],
        subjectSymbols: ["s"],
        reason,
      })
    const first = make("first")
    const second = make("second-but-same-id")
    expect(first.witnessId).toBe(second.witnessId)

    const other = makeStaticWitness({
      kind: "registration-callback",
      authority: "advisory",
      provenance: "ast",
      subjectFiles: ["c.py"],
      reason: "distinct",
    })

    const deduped = dedupeWitnesses([first, second, other])
    expect(deduped.length).toBe(2)
    expect(deduped[0]?.witnessId).toBe(first.witnessId)
    // first-seen wins
    expect(deduped[0]?.reason).toBe("first")
    expect(deduped[1]?.witnessId).toBe(other.witnessId)
  })
})
