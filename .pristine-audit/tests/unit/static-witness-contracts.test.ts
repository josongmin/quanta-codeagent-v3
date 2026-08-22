/**
 * Hellgate for the static-witness -> public-contract bridge (SCAFF-05).
 *
 * Witnesses are built through the real `makeStaticWitness` constructor (never
 * hand-rolled object literals) so the no-fake / provenance invariants are
 * exercised end to end. The keystone policy is now fail-closed: static-only
 * witnesses remain advisory evidence and NEVER mint required public contracts.
 *
 * Self-policing: this file and the module under test contain NO benchmark
 * instance prefix, no real gold file path, and no hidden-oracle label literal.
 * The negative-needle test assembles those forbidden strings from fragments at
 * runtime so the test does not match itself.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeStaticWitness } from "@/runner/batch/eval/static-witness"
import { buildStaticWitnessContracts } from "@/runner/batch/eval/static-witness-contracts"

// Generic, made-up paths/symbols — deliberately NOT any real repo or benchmark.
const FILE_ALPHA = "pkg/widget/alpha_adapter.py"
const FILE_BETA = "pkg/widget/beta_adapter.py"
const SYMBOL_RENDER = "WidgetAdapter.render"

describe("buildStaticWitnessContracts", () => {
  it("authoritative override-family over 2 files stays advisory-only", () => {
    const witness = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "lsp",
      subjectFiles: [FILE_ALPHA, FILE_BETA],
      subjectSymbols: [SYMBOL_RENDER],
      reason: "two adapters override the same base method and must co-change",
    })

    expect(buildStaticWitnessContracts([witness])).toEqual([])
  })

  it("authoritative producer-consumer over 2 files stays advisory-only", () => {
    const witness = makeStaticWitness({
      kind: "producer-consumer",
      authority: "authoritative",
      provenance: "static-engine",
      subjectFiles: [FILE_ALPHA, FILE_BETA],
      reason: "alpha produces what beta consumes",
    })
    expect(buildStaticWitnessContracts([witness])).toEqual([])
  })

  it("authoritative registration-callback over 2 files stays advisory-only", () => {
    const witness = makeStaticWitness({
      kind: "registration-callback",
      authority: "authoritative",
      provenance: "repo-map",
      subjectFiles: [FILE_ALPHA, FILE_BETA],
      reason: "callback registered in alpha, dispatched in beta",
    })
    expect(buildStaticWitnessContracts([witness])).toEqual([])
  })

  it("authoritative unique-symbol-definer stays advisory-only", () => {
    const witness = makeStaticWitness({
      kind: "unique-symbol-definer",
      authority: "authoritative",
      provenance: "lsp",
      subjectFiles: [FILE_ALPHA],
      subjectSymbols: [SYMBOL_RENDER],
      reason: "symbol is uniquely defined in alpha",
    })

    expect(buildStaticWitnessContracts([witness])).toEqual([])
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

  it("multiple authoritative witnesses still produce ZERO contracts", () => {
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
    expect(buildStaticWitnessContracts([w1, w2])).toEqual([])
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
