/**
 * SCAFF-03 hellgate — the owner-evidence lattice. Clean owner admission must
 * rest on TYPED-RELATION provenance (a static witness), never on a heuristic
 * score / lead-gap / same-symbol sibling. Drives the REAL chain:
 *
 *   makeStaticWitness → witnessAuthoritativeOwners → buildFaultEvidencePacket
 *     → decideOwnerAdmission({clean}) / assembleClosureBundle
 *
 * No instance id / gold path / FAIL_TO_PASS regex anywhere — needles for the
 * self-policing scan are assembled from fragments.
 */
import { describe, expect, it } from "bun:test"
import { assembleClosureBundle } from "@/agent/closure/bundle"
import { buildFaultEvidencePacket, ownerStrength } from "@/agent/fault-evidence/build"
import { decideOwnerAdmission } from "@/agent/owner-admission"
import { makeStaticWitness, witnessAuthoritativeOwners } from "@/runner/batch/eval/static-witness"

const A = "pkg/base/client.py"
const B = "pkg/postgres/client.py"
const SYM = "settings_to_cmd_args_env"

const uniqueDefiner = makeStaticWitness({
  kind: "unique-symbol-definer",
  authority: "authoritative",
  provenance: "ast",
  subjectFiles: [A],
  subjectSymbols: [SYM],
  reason: "sole static definer of the issue symbol",
})
const overrideFamily = makeStaticWitness({
  kind: "override-family",
  authority: "authoritative",
  provenance: "ast",
  subjectFiles: [A, B],
  subjectSymbols: [SYM],
  reason: "method overridden across two owner files",
})

const cleanAdmit = (input: Parameters<typeof buildFaultEvidencePacket>[0]) =>
  decideOwnerAdmission({ packet: buildFaultEvidencePacket(input), clean: true })

describe("SCAFF-03 — witnessAuthoritativeOwners extractor (typed-relation only)", () => {
  it("a unique-symbol-definer yields its single owner file", () => {
    expect(witnessAuthoritativeOwners([uniqueDefiner])).toEqual([{ file: A, forSymbol: SYM }])
  })

  it("a COMPLETE override-family yields EVERY family file (not an arbitrary one)", () => {
    expect(witnessAuthoritativeOwners([overrideFamily]).map((o) => o.file)).toEqual([A, B])
  })

  it("RED-ON-INJECTION: an ADVISORY witness yields NO owner (no fake authority)", () => {
    const advisory = makeStaticWitness({
      kind: "override-family",
      authority: "advisory",
      provenance: "ast",
      subjectFiles: [A, B],
      subjectSymbols: [SYM],
      reason: "ripgrep sibling — not structurally proven",
    })
    expect(witnessAuthoritativeOwners([advisory])).toEqual([])
  })

  it("a SINGLE-file override-family is an incomplete obligation ⇒ NO owner", () => {
    const single = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "ast",
      subjectFiles: [A],
      subjectSymbols: [SYM],
      reason: "only one family file known",
    })
    expect(witnessAuthoritativeOwners([single])).toEqual([])
  })

  it("registration-callback / lifecycle-owner do NOT confer owner-admission authority", () => {
    const reg = makeStaticWitness({
      kind: "registration-callback",
      authority: "authoritative",
      provenance: "ast",
      subjectFiles: [A, B],
      subjectSymbols: ["register"],
      reason: "callback registration",
    })
    const life = makeStaticWitness({
      kind: "lifecycle-owner",
      authority: "authoritative",
      provenance: "ast",
      subjectFiles: [A],
      subjectSymbols: ["setUp"],
      reason: "lifecycle owner",
    })
    expect(witnessAuthoritativeOwners([reg, life])).toEqual([])
  })
})

describe("SCAFF-03 — clean owner admission rests on typed provenance", () => {
  it("a static-witness owner is AUTHORITATIVE; the same file as stage1-only is ADVISORY", () => {
    const witnessed = buildFaultEvidencePacket({
      issueText: `${SYM} drops the empty environment`,
      stage1Files: [{ file: A, score: 9 }],
      witnessOwners: [{ file: A, forSymbol: SYM }],
    })
    expect(ownerStrength(witnessed.candidates[0]!)).toBe("authoritative")

    const stage1Only = buildFaultEvidencePacket({
      issueText: `${SYM} drops the empty environment`,
      stage1Files: [{ file: A, score: 9 }],
    })
    expect(ownerStrength(stage1Only.candidates[0]!)).toBe("advisory")
  })

  it("HELLGATE: stage1-only evidence cannot admit a clean owner", () => {
    const r = cleanAdmit({ issueText: "no symbols named", stage1Files: [{ file: A, score: 9 }] })
    expect(r.admit).toBe(false)
  })

  it("HELLGATE: same-symbol sibling (owner-resolve) without a witness stays advisory — no clean admit", () => {
    const r = cleanAdmit({
      issueText: "resolve only",
      stage1Files: [{ file: A, score: 1 }],
      ownerResolved: [{ file: A, forSymbol: SYM }],
    })
    expect(r.admit).toBe(false)
  })

  it("ONE typed-witness owner ⇒ clean admit, single-site", () => {
    const r = cleanAdmit({
      issueText: `${SYM} bug`,
      stage1Files: [{ file: A, score: 1 }],
      witnessOwners: witnessAuthoritativeOwners([uniqueDefiner]),
    })
    expect(r.admit).toBe(true)
    expect(r.owner).toBe(A)
    expect(r.coverageExpectation).toBe("single-site")
    expect(r.evidenceStrength).toBe("authoritative")
  })

  it("HELLGATE: TWO authoritative owners (override family) ⇒ cross-owner, NOT an arbitrary single pick", () => {
    const r = cleanAdmit({
      issueText: `${SYM} bug`,
      stage1Files: [{ file: A, score: 1 }],
      witnessOwners: witnessAuthoritativeOwners([overrideFamily]),
    })
    expect(r.admit).toBe(false)
    expect(r.owner).toBeNull()
    expect(r.coverageExpectation).toBe("cross-owner")
  })
})

describe("SCAFF-03 — authority alone does not bypass verification", () => {
  it("HELLGATE: a single witness owner with NO repro signal does NOT route to a commit-fast gate", () => {
    const bundle = assembleClosureBundle({
      evidence: {
        issueText: `${SYM} bug`,
        stage1Files: [{ file: A, score: 1 }],
        witnessOwners: witnessAuthoritativeOwners([uniqueDefiner]),
      },
      ownerClean: true,
      plan: {},
      gate: {
        stakes: { patchFileCount: 1, crossFile: false, destructive: false },
        uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
        signal: { reproAvailable: false, lspAvailable: false },
        issueProvidesFix: false,
      },
    })
    // Owner is admitted from typed provenance, but the gate must still demand
    // verification — owner authority alone is not a green light to commit.
    expect(bundle.owner.admit).toBe(true)
    expect(bundle.gate.action).not.toBe("commit")
  })
})
