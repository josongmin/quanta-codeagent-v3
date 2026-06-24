import { describe, expect, it } from "bun:test"
import {
  type Candidate,
  runSelection,
  type SelectionPorts,
} from "@/runner/batch/eval/selection-executor"

/**
 * T1 family-coverage veto — DEFAULT-OFF, opt-IN. The clean-mode veto
 * (`hard:familyCoverageMissing`) was reverted as NET-NEGATIVE producer-consumer
 * over-demand: by default a producer-only-correct (sibling-missing) candidate is
 * admissible (NO veto). It only fires when explicitly enabled with
 * `familyCoverageVeto: true`. The cases below keep BOTH directions as a paired
 * control so the gate cannot silently die. Only `familyCoverageVeto` varies.
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

describe("T1 family-coverage veto (DEFAULT-OFF, opt-in)", () => {
  // ── Paired control: default-OFF vs opt-in-ON for the SAME candidate ──
  it("DEFAULT (undefined): a tagged-incomplete producer-only candidate is ADMISSIBLE + NO reason (veto reverted, net-negative)", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      ports: { generate: genOnce(taggedIncomplete()) },
    })
    expect(familyMissingReason(r.scored[0])).toBe(false)
    expect(r.scored[0]?.verdict.admissible).toBe(true)
    expect(r.winner?.files).toEqual(["pkg/producer.py"])
  })

  it("OPT-IN (familyCoverageVeto:true): the SAME candidate IS vetoed (reason emitted, non-admissible)", async () => {
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

  it("explicit false matches the default (NO reason, admissible)", async () => {
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
  })

  // ── When opted-IN, provenance gating still narrows the veto correctly ──
  it("opt-in + advisory co-change family provenance does NOT hard-veto in clean mode", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      familyCoverageVeto: true,
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

  it("opt-in + structural family provenance hard-vetoes incomplete coverage", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      familyCoverageVeto: true,
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

  it("opt-in + CHA-derived structural family provenance also hard-vetoes incomplete coverage", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: owners(),
      familyCoverageVeto: true,
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

  // ── Structural provenance does NOT veto when the veto is OFF (default) ──
  it("DEFAULT + structural family provenance does NOT veto (default-off dominates provenance)", async () => {
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
    expect(familyMissingReason(r.scored[0])).toBe(false)
    expect(r.scored[0]?.verdict.admissible).toBe(true)
  })
})
