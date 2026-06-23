/**
 * jun-23 evidence-packet impl-completeness — A6 / A7 / B6 hellgate.
 *
 * Each block is red-on-injection: it fails on the pre-fix code and passes after.
 *
 *  - A6: the producer→consumer DIRECTION (`fromFile`) must reach an emitted
 *    business artifact (candidate family seed/producerFile), not be discarded
 *    into `witnessId` only.
 *  - A7: the dead `lifecycle-owner` StaticWitnessKind is removed — proven safe
 *    because NO producer (the only one is `buildAstStaticWitnesses`) emits it.
 *  - B6: a non-Python owner source that IS read but yields no def/class structure
 *    emits an EXPLICIT language-unsupported diagnostic, not a silent no-op.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { staticWitnessesToFamilies } from "@/runner/batch/eval/candidate-families"
import { makeStaticWitness } from "@/runner/batch/eval/static-witness"
import {
  buildAstStaticWitnesses,
  type StaticWitnessProviderInput,
  staticWitnessLanguageDiagnostics,
} from "@/runner/batch/eval/static-witness-adapter"

const sourceMap =
  (m: Record<string, string>): ((rel: string) => string | null) =>
  (rel) =>
    m[rel] ?? null

// ---------------------------------------------------------------------------
// A6 — producer→consumer direction reaches the emitted family artifact.
// ---------------------------------------------------------------------------
describe("A6 — static-witness DIRECTION reaches a business consumer", () => {
  test("producer-consumer family surfaces producer/consumer direction (not folded into id only)", () => {
    const witness = makeStaticWitness({
      kind: "producer-consumer",
      authority: "authoritative",
      provenance: "ast",
      subjectFiles: ["pkg/consumer.py", "pkg/producer.py"],
      subjectSymbols: ["build_widget"],
      fromFile: "pkg/producer.py",
      reason: "producer-consumer: `build_widget` produced in pkg/producer.py",
    })
    const fams = staticWitnessesToFamilies([witness])
    expect(fams.length).toBe(1)
    const fam = fams[0]
    if (fam === undefined) throw new Error("expected one family")

    // direction is STRUCTURALLY present, not just inside witnessId.
    expect(fam.producerFile).toBe("pkg/producer.py")
    // and it reaches the model-facing seed text naming producer + consumer.
    expect(fam.seed).toBeDefined()
    expect(fam.seed ?? "").toContain("pkg/producer.py")
    expect(fam.seed ?? "").toContain("pkg/consumer.py")
    expect(fam.seed ?? "").toContain("build_widget")
    // producer is the lead owner file (direction-ordered, not bare sort).
    expect(fam.ownerFiles[0]).toBe("pkg/producer.py")
  })

  test("a directionless family (override-family) carries no producerFile", () => {
    const witness = makeStaticWitness({
      kind: "override-family",
      authority: "authoritative",
      provenance: "ast",
      subjectFiles: ["pkg/a.py", "pkg/b.py"],
      subjectSymbols: ["m"],
      reason: "override-family: `m`",
    })
    const fams = staticWitnessesToFamilies([witness])
    expect(fams[0]?.producerFile).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// A7 — `lifecycle-owner` StaticWitnessKind is dead; removal is safe.
// ---------------------------------------------------------------------------
describe("A7 — no producer emits `lifecycle-owner` (removal safety)", () => {
  test("the AST adapter never emits a lifecycle-owner witness over any input", () => {
    // The adapter is the ONLY producer of StaticWitness. Feed it sources that
    // look like setup/teardown/state-reset lifecycle code; assert no witness
    // claims the (removed) lifecycle-owner kind.
    const input: StaticWitnessProviderInput = {
      problemStatement: "setUp / tearDown / reset_state across fixtures.",
      ownerCandidates: ["pkg/fixture_a.py", "pkg/fixture_b.py"],
      readSource: sourceMap({
        "pkg/fixture_a.py": [
          "class A:",
          "    def setUp(self):",
          "        self.state = 0",
          "    def tearDown(self):",
          "        self.state = None",
        ].join("\n"),
        "pkg/fixture_b.py": [
          "class B:",
          "    def reset_state(self):",
          "        self.state = 0",
        ].join("\n"),
      }),
    }
    const kinds = buildAstStaticWitnesses(input).map((w) => w.kind)
    expect(kinds).not.toContain("lifecycle-owner")
  })

  test("source grep: no makeStaticWitness call site declares kind lifecycle-owner", () => {
    const adapterSrc = readFileSync(
      join(import.meta.dir, "../../src/runner/batch/eval/static-witness-adapter.ts"),
      "utf8",
    )
    // assembled so the guard's own string doesn't false-match the corpus.
    const needle = `kind: "lifecycle${"-"}owner"`
    expect(adapterSrc.includes(needle)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// B6 — non-Python silent no-op becomes an explicit diagnostic.
// ---------------------------------------------------------------------------
describe("B6 — non-Python source yields an explicit diagnostic, not silence", () => {
  test("a read JS/TS source with no python def/class emits static_witness_unsupported_language", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: "Something broke in the bundler.",
      ownerCandidates: ["pkg/widget.ts"],
      readSource: sourceMap({
        "pkg/widget.ts": ["export function buildWidget(spec) {", "  return spec;", "}"].join("\n"),
      }),
    }
    const diags = staticWitnessLanguageDiagnostics(input)
    expect(diags.length).toBe(1)
    expect(diags[0]?.kind).toBe("static_witness_unsupported_language")
    expect(diags[0]?.file).toBe("pkg/widget.ts")
    // it produced NO witness — the diagnostic explains the empty result honestly.
    expect(buildAstStaticWitnesses(input)).toEqual([])
  })

  test("a missing source (readSource null) is NOT mislabeled as unsupported language", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: "x",
      ownerCandidates: ["pkg/gone.py"],
      readSource: () => null,
    }
    expect(staticWitnessLanguageDiagnostics(input)).toEqual([])
  })

  test("a real Python source with defs emits NO unsupported-language diagnostic", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: "x",
      ownerCandidates: ["pkg/ok.py"],
      readSource: sourceMap({ "pkg/ok.py": ["def f():", "    return 1"].join("\n") }),
    }
    expect(staticWitnessLanguageDiagnostics(input)).toEqual([])
  })

  test("a .py file that simply has no defs (e.g. constants) is NOT flagged unsupported language", () => {
    const input: StaticWitnessProviderInput = {
      problemStatement: "x",
      ownerCandidates: ["pkg/constants.py"],
      readSource: sourceMap({ "pkg/constants.py": "X = 1\nY = 2\n" }),
    }
    expect(staticWitnessLanguageDiagnostics(input)).toEqual([])
  })
})
