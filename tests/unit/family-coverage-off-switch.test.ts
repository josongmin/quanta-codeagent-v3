import { describe, expect, it } from "bun:test"
import {
  type Candidate,
  runSelection,
  type SelectionPorts,
} from "@/runner/batch/eval/selection-executor"

/**
 * T1 measurement off-switch — the clean-mode family-coverage veto
 * (`hard:familyCoverageMissing`) makes a tagged-incomplete candidate
 * non-admissible by default (byte-identical), and `familyCoverageVeto: false`
 * removes that reason so an A/B baseline can measure the producer-consumer
 * over-demand cost before promotion. Mirrors the T0 baseline harness exactly so
 * only `familyCoverageVeto` varies.
 */

const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({
  patch: "+++ b/x.py\n+changed",
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: true,
  ...over,
})

const patchForFiles = (files: readonly string[]): string =>
  files
    .map((file) =>
      [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    )
    .join("\n")

const genOnce =
  (c: Candidate): SelectionPorts["generate"] =>
  async () =>
    c

const taggedIncomplete = (): Candidate =>
  cand({
    id: "cand-0",
    patch: patchForFiles(["pkg/producer.py"]),
    files: ["pkg/producer.py"],
    familyId: "producer-consumer",
    familyOwnerFiles: ["pkg/producer.py", "pkg/consumer.py"],
  })

const owners = (): Set<string> => new Set(["pkg/producer.py", "pkg/consumer.py"])

const familyMissingReason = (c: { verdict: { reasons: string[] } } | undefined): boolean =>
  c?.verdict.reasons.some((x) => x.startsWith("hard:familyCoverageMissing=")) ?? false

describe("T1 family-coverage veto off-switch", () => {
  it("DEFAULT (undefined): a tagged-incomplete producer-only candidate is non-admissible + reason emitted", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      ports: { generate: genOnce(taggedIncomplete()) },
    })
    expect(r.scored[0]?.verdict.admissible).toBe(false)
    expect(familyMissingReason(r.scored[0])).toBe(true)
  })

  it("OFF (familyCoverageVeto:false): the SAME candidate carries NO family-coverage reason and is admissible", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      familyCoverageVeto: false,
      ports: { generate: genOnce(taggedIncomplete()) },
    })
    expect(familyMissingReason(r.scored[0])).toBe(false)
    expect(r.scored[0]?.verdict.admissible).toBe(true)
    expect(r.winner?.files).toEqual(["pkg/producer.py"])
  })

  it("explicit true behaves like default ON (reason emitted, non-admissible)", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      familyCoverageVeto: true,
      ports: { generate: genOnce(taggedIncomplete()) },
    })
    expect(r.scored[0]?.verdict.admissible).toBe(false)
    expect(familyMissingReason(r.scored[0])).toBe(true)
  })

  it("advisory co-change family provenance does NOT hard-veto in clean mode", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      ports: {
        generate: genOnce({
          ...taggedIncomplete(),
          familySourceEvidence: ["static-symbol-witness"],
        }),
      },
    })
    expect(familyMissingReason(r.scored[0])).toBe(false)
    expect(r.scored[0]?.verdict.admissible).toBe(true)
  })

  it("structural family provenance still hard-vetoes incomplete coverage", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      ports: {
        generate: genOnce({
          ...taggedIncomplete(),
          familySourceEvidence: ["static-witness:ast"],
        }),
      },
    })
    expect(familyMissingReason(r.scored[0])).toBe(true)
    expect(r.scored[0]?.verdict.admissible).toBe(false)
  })

  it("CHA-derived structural family provenance also hard-vetoes incomplete coverage", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      ports: {
        generate: genOnce({
          ...taggedIncomplete(),
          familySourceEvidence: ["cha-multisite:python-ast"],
        }),
      },
    })
    expect(familyMissingReason(r.scored[0])).toBe(true)
    expect(r.scored[0]?.verdict.admissible).toBe(false)
  })
})
