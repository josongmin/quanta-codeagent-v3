/**
 * Hellgate for the static-witness -> public-contract bridge (SCAFF-05).
 *
 * Witnesses are built through the real `makeStaticWitness` constructor (never
 * hand-rolled object literals) so the no-fake / provenance invariants are
 * exercised end to end. The keystone test asserts the exact "single-site cannot
 * beat a complete co-change family" fix: an authoritative override-family over two
 * GENERIC files becomes one required multi-site-family contract, and only a
 * candidate touching BOTH files satisfies it.
 *
 * Self-policing: this file and the module under test contain NO benchmark
 * instance prefix, no real gold file path, and no hidden-oracle label literal.
 * The negative-needle test assembles those forbidden strings from fragments at
 * runtime so the test does not match itself.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"
import { requiredContractsSatisfiedCount } from "@/runner/batch/eval/public-contract-bundle"
import type { ContractCandidate } from "@/runner/batch/eval/public-contract-types"
import { buildStaticWitnessContracts } from "@/runner/batch/eval/static-witness-contracts"
import { makeStaticWitness } from "@/runner/batch/eval/static-witness"

// Generic, made-up paths/symbols — deliberately NOT any real repo or benchmark.
const FILE_ALPHA = "pkg/widget/alpha_adapter.py"
const FILE_BETA = "pkg/widget/beta_adapter.py"
const SYMBOL_RENDER = "WidgetAdapter.render"

const candidateTouching = (...files: string[]): ContractCandidate => ({
  touchedFiles: files,
  touchedSymbols: [],
})

describe("buildStaticWitnessContracts", () => {
  it("django-critical: authoritative override-family over 2 files -> one required multi-site contract that ONLY a both-files candidate satisfies", () => {
    const witness = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "lsp",
      subjectFiles: [FILE_ALPHA, FILE_BETA],
      subjectSymbols: [SYMBOL_RENDER],
      reason: "two adapters override the same base method and must co-change",
    })

    const contracts = buildStaticWitnessContracts([witness])

    // Exactly one required multi-site-family contract over BOTH files.
    expect(contracts.length).toBe(1)
    const contract = contracts[0]!
    expect(contract.kind).toBe("multi-site-family")
    expect(contract.strength).toBe("required")
    expect(contract.provenance).toBe("static-witness")
    expect([...contract.subjectFiles].sort()).toEqual([FILE_ALPHA, FILE_BETA].sort())

    const bundle = { contracts }

    // THE fix: a single-site patch (only one of the two files) satisfies 0 required contracts...
    expect(requiredContractsSatisfiedCount(bundle, candidateTouching(FILE_ALPHA))).toBe(0)
    expect(requiredContractsSatisfiedCount(bundle, candidateTouching(FILE_BETA))).toBe(0)
    // ...while the complete co-change (BOTH files) satisfies the required contract.
    expect(requiredContractsSatisfiedCount(bundle, candidateTouching(FILE_ALPHA, FILE_BETA))).toBe(1)
  })

  it("authoritative producer-consumer over 2 files -> required multi-site-family", () => {
    const witness = makeStaticWitness({
      kind: "producer-consumer",
      authority: "authoritative",
      provenance: "static-engine",
      subjectFiles: [FILE_ALPHA, FILE_BETA],
      reason: "alpha produces what beta consumes",
    })
    const contracts = buildStaticWitnessContracts([witness])
    expect(contracts.length).toBe(1)
    expect(contracts[0]!.kind).toBe("multi-site-family")
    expect(contracts[0]!.strength).toBe("required")
  })

  it("authoritative registration-callback over 2 files -> required multi-site-family", () => {
    const witness = makeStaticWitness({
      kind: "registration-callback",
      authority: "authoritative",
      provenance: "repo-map",
      subjectFiles: [FILE_ALPHA, FILE_BETA],
      reason: "callback registered in alpha, dispatched in beta",
    })
    const contracts = buildStaticWitnessContracts([witness])
    expect(contracts.length).toBe(1)
    expect(contracts[0]!.kind).toBe("multi-site-family")
  })

  it("authoritative unique-symbol-definer -> required owner-must-touch; only the owner-file candidate satisfies it", () => {
    const witness = makeStaticWitness({
      kind: "unique-symbol-definer",
      authority: "authoritative",
      provenance: "lsp",
      subjectFiles: [FILE_ALPHA],
      subjectSymbols: [SYMBOL_RENDER],
      reason: "symbol is uniquely defined in alpha",
    })

    const contracts = buildStaticWitnessContracts([witness])
    expect(contracts.length).toBe(1)
    const contract = contracts[0]!
    expect(contract.kind).toBe("owner-must-touch")
    expect(contract.strength).toBe("required")
    expect([...contract.subjectFiles]).toEqual([FILE_ALPHA])

    const bundle = { contracts }
    expect(requiredContractsSatisfiedCount(bundle, candidateTouching(FILE_ALPHA))).toBe(1)
    expect(requiredContractsSatisfiedCount(bundle, candidateTouching(FILE_BETA))).toBe(0)
  })

  it("no-fake guard: an ADVISORY witness produces ZERO contracts (red-on-injection)", () => {
    const advisory = makeStaticWitness({
      kind: "override-family",
      authority: "advisory",
      provenance: "repo-map",
      subjectFiles: [FILE_ALPHA, FILE_BETA],
      reason: "advisory sibling guess from a ripgrep co-occurrence",
    })
    expect(buildStaticWitnessContracts([advisory])).toEqual([])
  })

  it("a 1-file authoritative override-family yields ZERO multi-site contract", () => {
    const witness = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "lsp",
      subjectFiles: [FILE_ALPHA],
      reason: "single-file family is not a multi-site obligation",
    })
    expect(buildStaticWitnessContracts([witness])).toEqual([])
  })

  it("dedup: two witnesses producing the same contractId collapse to one contract", () => {
    const w1 = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "lsp",
      subjectFiles: [FILE_ALPHA, FILE_BETA],
      reason: "first witness",
    })
    const w2 = makeStaticWitness({
      kind: "producer-consumer",
      authority: "authoritative",
      provenance: "static-engine",
      subjectFiles: [FILE_BETA, FILE_ALPHA],
      reason: "different kind/provenance but same family -> same multi-site contractId",
    })
    const contracts = buildStaticWitnessContracts([w1, w2])
    expect(contracts.length).toBe(1)
    expect(contracts[0]!.kind).toBe("multi-site-family")
  })

  it("self-policing: neither this test nor the module names a benchmark instance, gold path, or oracle label", () => {
    const here = __dirname
    const testSrc = readFileSync(join(here, "static-witness-contracts.test.ts"), "utf8")
    const moduleSrc = readFileSync(
      join(here, "..", "..", "src", "runner", "batch", "eval", "static-witness-contracts.ts"),
      "utf8",
    )

    // Assemble forbidden needles from fragments so this test does not match itself.
    const instancePrefixes = ["django" + "__", "astropy" + "__"]
    const goldPathFragment = "/db/backends/" + "postgresql/client.py"
    const oracleLabels = ["FAIL" + "_TO_PASS", "PASS" + "_TO_PASS"]
    const needles = [...instancePrefixes, goldPathFragment, ...oracleLabels]

    for (const src of [testSrc, moduleSrc]) {
      for (const needle of needles) {
        expect(src.includes(needle)).toBe(false)
      }
    }
  })
})
