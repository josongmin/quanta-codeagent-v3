/**
 * SCAFF-03 hellgate — the owner-evidence lattice. Clean owner admission now
 * rests on AUTHORITATIVE PUBLIC evidence only (`issue-file`). Typed structural
 * witnesses still feed localization/repair evidence, but they do NOT, by
 * themselves, become clean owner-admission authority. Drives the REAL chain:
 *
 *   makeStaticWitness → witnessStructuralOwnerCandidates → buildFaultEvidencePacket
 *     → decideOwnerAdmission({clean}) / assembleClosureBundle
 *
 * No instance id / gold path / FAIL_TO_PASS regex anywhere — needles for the
 * self-policing scan are assembled from fragments.
 */
import { describe, expect, it } from "bun:test"
import { assembleClosureBundle } from "@/agent/closure/bundle"
import { buildFaultEvidencePacket, ownerStrength } from "@/agent/fault-evidence/build"
import { decideOwnerAdmission } from "@/agent/owner-admission"
import { buildClosureSession } from "@/runner/batch/eval/closure-session"
import {
  makeStaticWitness,
  witnessStructuralOwnerCandidates,
} from "@/runner/batch/eval/static-witness"
import { nth } from "../_helpers/expect-present"

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

describe("SCAFF-03 — witnessStructuralOwnerCandidates extractor (typed-relation only)", () => {
  it("a unique-symbol-definer yields its single owner file", () => {
    expect(witnessStructuralOwnerCandidates([uniqueDefiner])).toEqual([{ file: A, forSymbol: SYM }])
  })

  it("a COMPLETE override-family yields EVERY family file (not an arbitrary one)", () => {
    expect(witnessStructuralOwnerCandidates([overrideFamily]).map((o) => o.file)).toEqual([A, B])
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
    expect(witnessStructuralOwnerCandidates([advisory])).toEqual([])
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
    expect(witnessStructuralOwnerCandidates([single])).toEqual([])
  })

  it("registration-callback does NOT confer owner-admission authority", () => {
    const reg = makeStaticWitness({
      kind: "registration-callback",
      authority: "authoritative",
      provenance: "ast",
      subjectFiles: [A, B],
      subjectSymbols: ["register"],
      reason: "callback registration",
    })
    expect(witnessStructuralOwnerCandidates([reg])).toEqual([])
  })
})

describe("SCAFF-03 — static witness evidence stays advisory in clean owner admission", () => {
  it("a static-witness owner stays ADVISORY; the same file as stage1-only is also ADVISORY", () => {
    const witnessed = buildFaultEvidencePacket({
      issueText: `${SYM} drops the empty environment`,
      stage1Files: [{ file: A, score: 9 }],
      witnessOwners: [{ file: A, forSymbol: SYM }],
    })
    expect(ownerStrength(nth(witnessed.candidates, 0, "witnessed.candidates"))).toBe("advisory")

    const stage1Only = buildFaultEvidencePacket({
      issueText: `${SYM} drops the empty environment`,
      stage1Files: [{ file: A, score: 9 }],
    })
    expect(ownerStrength(nth(stage1Only.candidates, 0, "stage1Only.candidates"))).toBe("advisory")
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

  it("ONE typed-witness owner still does NOT clean-admit without issue-file authority", () => {
    const r = cleanAdmit({
      issueText: `${SYM} bug`,
      stage1Files: [{ file: A, score: 1 }],
      witnessOwners: witnessStructuralOwnerCandidates([uniqueDefiner]),
    })
    expect(r.admit).toBe(false)
    expect(r.owner).toBeNull()
    expect(r.coverageExpectation).toBe("cross-owner")
    expect(r.evidenceStrength).toBeNull()
  })

  it("HELLGATE: TWO typed-witness owners stay cross-owner, NOT an arbitrary single pick", () => {
    const r = cleanAdmit({
      issueText: `${SYM} bug`,
      stage1Files: [{ file: A, score: 1 }],
      witnessOwners: witnessStructuralOwnerCandidates([overrideFamily]),
    })
    expect(r.admit).toBe(false)
    expect(r.owner).toBeNull()
    expect(r.coverageExpectation).toBe("cross-owner")
    expect(r.evidenceStrength).toBeNull()
  })
})

const bundleFor = (witnessOwners: ReturnType<typeof witnessStructuralOwnerCandidates>) =>
  assembleClosureBundle({
    evidence: { issueText: `${SYM} bug`, stage1Files: [{ file: A, score: 1 }], witnessOwners },
    ownerClean: true,
    plan: {},
    gate: {
      stakes: { patchFileCount: 1, crossFile: false, destructive: false },
      uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
      signal: { reproAvailable: false, lspAvailable: false },
      issueProvidesFix: false,
    },
  })

describe("SCAFF-03 — witness owners feed ONLY the clean path (research byte-identical)", () => {
  const sessionArgs = (ownerClean: boolean) =>
    buildClosureSession({
      problemStatement: `${SYM} bug`,
      stage1Files: [{ file: A, score: 1 }],
      witnessOwners: witnessStructuralOwnerCandidates([uniqueDefiner]),
      posture: { lspNav: false, primaryRail: false, faultEvidence: true },
      ownerClean,
    })

  it("CLEAN: the witness owner is present as structural evidence but NOT admitted", () => {
    const s = sessionArgs(true)
    const cand = s.bundle.evidence.candidates.find((c) => c.file === A)
    expect(cand?.sources).toContain("static-witness")
    expect(s.bundle.owner.admit).toBe(false)
    expect(s.bundle.gate.action).toBe("verify")
  })

  it("HELLGATE: LEGACY/research withholds the witness owner — no `static-witness` source, no admit", () => {
    const s = sessionArgs(false)
    const cand = s.bundle.evidence.candidates.find((c) => c.file === A)
    expect(cand?.sources ?? []).not.toContain("static-witness")
    // stage1-only legacy candidate stays advisory and uncorroborated ⇒ no admit.
    expect(s.bundle.owner.admit).toBe(false)
  })
})

describe("SCAFF-03 — FAMILY authority forces verification (no single-site commit)", () => {
  it("HELLGATE: a cross-owner override family routes the gate to VERIFY, never commit-now", () => {
    // The gate action enum is exactly "commit-now" | "verify" — assert the REAL
    // value so the tooth is not vacuous. Two authoritative owners ⇒ cross-owner
    // ⇒ uncertain ⇒ a single-site edit must NOT commit-fast; it must verify the
    // co-change. This is the exact django-RCA safety property SCAFF-03 protects.
    const bundle = bundleFor(witnessStructuralOwnerCandidates([overrideFamily]))
    expect(bundle.owner.coverageExpectation).toBe("cross-owner")
    expect(bundle.gate.action).toBe("verify")
  })

  it("PAIRED CONTROL: a single unique-definer witness also stays verify-first without public owner authority", () => {
    const bundle = bundleFor(witnessStructuralOwnerCandidates([uniqueDefiner]))
    expect(bundle.owner.admit).toBe(false)
    expect(bundle.owner.coverageExpectation).toBe("cross-owner")
    expect(bundle.gate.action).toBe("verify")
  })
})
