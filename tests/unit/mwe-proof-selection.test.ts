/**
 * SCAFF-06 wiring proof — the executable public-MWE proof receipt is the
 * selector's TOP authority tier, driven END-TO-END through runSelection (not
 * just the pure comparator). Proves the tier ENGAGES:
 *   - patched_green outranks a smaller no-receipt candidate (admit),
 *   - candidate_red is ranked BELOW a bigger no-receipt candidate (veto),
 *   - execution_failed is NEUTRAL — infra never vetoes,
 *   - absent receipts ⇒ byte-identical selection (minimality decides).
 *
 * No instance id / gold path / FAIL_TO_PASS regex — needles from fragments.
 */
import { describe, expect, it } from "bun:test"
import { compareLexTiers } from "@/agent/verification-bundle"
import { type MweProofReceipt, mweProofAuthorityRank } from "@/runner/batch/eval/mwe-proof"
import { type Candidate, runSelection } from "@/runner/batch/eval/selection-executor"

const A = "pkg/base/client.py"
const B = "pkg/postgres/client.py"
const diff1 = (f: string) =>
  `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1,1 +1,1 @@\n-old\n+new`
const cand = (id: string, files: readonly string[], mweReceipt?: MweProofReceipt): Candidate => ({
  id,
  patch: files.map(diff1).join("\n"),
  turns: 1,
  files,
  baseValidatedRed: true,
  ...(mweReceipt ? { mweReceipt } : {}),
})

const select = (c0: Candidate, c1: Candidate) =>
  runSelection({
    n: 2,
    seeds: [undefined, undefined],
    owners: new Set([A, B]),
    mode: "clean",
    ports: {
      generate: async (i) => [c0, c1][i] as Candidate,
      applyClean: async () => true,
    },
  })

describe("SCAFF-06 — mweProofAuthorityRank (only executed oracle outcomes speak)", () => {
  it("patched_green ⇒ +1, candidate_red ⇒ -1, infra/none/absent ⇒ 0", () => {
    expect(mweProofAuthorityRank({ state: "patched_green" })).toBe(1)
    expect(mweProofAuthorityRank({ state: "candidate_red" })).toBe(-1)
    expect(mweProofAuthorityRank({ state: "execution_failed" })).toBe(0)
    expect(mweProofAuthorityRank({ state: "base_red" })).toBe(0)
    expect(mweProofAuthorityRank({ state: "not_found" })).toBe(0)
    expect(mweProofAuthorityRank(undefined)).toBe(0)
  })
})

describe("SCAFF-06 — the MWE tier dominates the lexicographic lattice", () => {
  it("the top tier decides BEFORE proofStrength/minimality, and absent ⇒ no effect", () => {
    const base = {
      proofStrength: 0,
      executedKeepGreen: 0 as const,
      requiredContractsSatisfied: 0,
      contractsSatisfied: 0,
      familyRank: 0,
      sourceFiles: 1,
      addedLines: 1,
      newDefs: 0,
      newFiles: 0,
      order: 0,
    }
    // patched_green beats a higher-proofStrength candidate (top tier wins first).
    expect(compareLexTiers({ ...base, mweProof: 1 }, { ...base, proofStrength: 9 })).toBeLessThan(0)
    // candidate_red is ranked BELOW a neutral (absent) candidate.
    expect(compareLexTiers({ ...base, mweProof: -1 }, base)).toBeGreaterThan(0)
    // absent mweProof is transparent: the tier falls through to `order` (0 < 1).
    expect(compareLexTiers(base, { ...base, order: 1 })).toBeLessThan(0)
  })
})

describe("SCAFF-06 — receipt flips runSelection end-to-end", () => {
  it("ADMIT: a patched_green candidate wins over a SMALLER no-receipt one", async () => {
    // cand-0 (single file) would win on minimality; cand-1 (two files) proves it.
    const r = await select(cand("cand-0", [A]), cand("cand-1", [A, B], { state: "patched_green" }))
    expect(r.winner?.id).toBe("cand-1")
  })

  it("VETO: a candidate_red candidate loses to a BIGGER no-receipt one", async () => {
    // cand-0 (single file, would win on minimality) is provably broken ⇒ ranked last.
    const r = await select(cand("cand-0", [A], { state: "candidate_red" }), cand("cand-1", [A, B]))
    expect(r.winner?.id).toBe("cand-1")
  })

  it("INFRA NEUTRAL: execution_failed does NOT veto — the smaller candidate still wins", async () => {
    // cand-0 had an infra failure running the MWE; that must NOT count against it,
    // so minimality (single file) still picks it over the bigger no-receipt cand-1.
    const r = await select(
      cand("cand-0", [A], { state: "execution_failed" }),
      cand("cand-1", [A, B]),
    )
    expect(r.winner?.id).toBe("cand-0")
  })

  it("BYTE-IDENTICAL: with no receipts, minimality picks the smaller candidate", async () => {
    const r = await select(cand("cand-0", [A]), cand("cand-1", [A, B]))
    expect(r.winner?.id).toBe("cand-0")
  })
})
