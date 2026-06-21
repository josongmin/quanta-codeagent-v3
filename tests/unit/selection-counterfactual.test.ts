import { describe, expect, it } from "bun:test"
import { analyzePatchBudget } from "@/agent/patch-budget"
import {
  type Candidate,
  runSelection,
  type SelectionPorts,
  type SelectionRiskGateDecision,
} from "@/runner/batch/eval/selection-executor"

// ── fixtures ──────────────────────────────────────────────────────────────────
const OWNER = "pkg/owner.py"
const OWNER2 = "pkg/owner2.py"
const OTHER = "pkg/other.py"

const diff1 = (file: string): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,2 +1,2 @@",
    "-    old",
    "+    new_guard",
  ].join("\n")

/** Two-source-file diff (cross-file budget breach). */
const diff2 = `${diff1(OWNER)}\n${diff1(OTHER)}`

const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({
  patch: diff1(OWNER),
  turns: 1,
  files: [OWNER],
  baseValidatedRed: true,
  ...over,
})

/** Records every seed the executor asked each index to generate with. */
const recordingGen = (
  list: readonly Candidate[],
): { gen: SelectionPorts["generate"]; seeds: (string | undefined)[] } => {
  const seeds: (string | undefined)[] = []
  const gen: SelectionPorts["generate"] = async (i, seed) => {
    seeds[i] = seed
    return list[i] as Candidate
  }
  return { gen, seeds }
}

/** A structural expand decision carrying cand0's REAL patch-budget verdict, the
 *  way the production risk gate forwards it. */
const expandDecisionFor = (patch: string): SelectionRiskGateDecision => ({
  expand: true,
  reasons: ["patch-budget:source-file budget=1"],
  patchBudget: analyzePatchBudget(patch, {
    ownerFiles: [OWNER],
    runtimeExpandingPolicy: "gate",
  }),
})

describe("counterfactual select — seed (T-202)", () => {
  it("expands with a COUNTERFACTUAL seed for cand1, not the owner-focus seed", async () => {
    const { gen, seeds } = recordingGen([
      cand({ id: "cand-0", patch: diff2, files: [OWNER, OTHER] }),
      cand({ id: "cand-1", patch: diff1(OWNER), files: [OWNER] }),
    ])
    await runSelection({
      n: 2,
      seeds: [undefined, "OWNER-FOCUS-SENTINEL"],
      owners: new Set([OWNER]),
      counterfactual: true,
      riskGate: async (c) => expandDecisionFor(c.patch),
      ports: { generate: gen, applyClean: async () => true },
    })
    // cand1 was seeded with the counterfactual minimal-alternative, NOT seeds[1].
    expect(seeds[1]).not.toBe("OWNER-FOCUS-SENTINEL")
    expect(seeds[1]).toContain("counterfactual minimal alternative")
    expect(seeds[1]).toContain(`edit only \`${OWNER}\``)
  })

  it("RED-ON-INJECTION: counterfactual OFF keeps the owner-focus seed verbatim", async () => {
    const { gen, seeds } = recordingGen([
      cand({ id: "cand-0", patch: diff2, files: [OWNER, OTHER] }),
      cand({ id: "cand-1", patch: diff1(OWNER), files: [OWNER] }),
    ])
    await runSelection({
      n: 2,
      seeds: [undefined, "OWNER-FOCUS-SENTINEL"],
      owners: new Set([OWNER]),
      // counterfactual omitted ⇒ legacy arm
      riskGate: async (c) => expandDecisionFor(c.patch),
      ports: { generate: gen, applyClean: async () => true },
    })
    expect(seeds[1]).toBe("OWNER-FOCUS-SENTINEL")
  })
})

describe("counterfactual select — seed diversity + telemetry honesty (audit fixes)", () => {
  it("applies the counterfactual seed to cand1 ONLY; cand2+ keep owner-focus seeds", async () => {
    const { gen, seeds } = recordingGen([
      cand({ id: "cand-0", patch: diff2, files: [OWNER, OTHER] }),
      cand({ id: "cand-1", patch: diff1(OWNER), files: [OWNER] }),
      cand({ id: "cand-2", patch: diff1("pkg/third.py"), files: ["pkg/third.py"] }),
    ])
    await runSelection({
      n: 3,
      seeds: [undefined, "OWNER-1-SEED", "OWNER-2-SEED"],
      owners: new Set([OWNER]),
      counterfactual: true,
      riskGate: async (c) => expandDecisionFor(c.patch),
      ports: { generate: gen, applyClean: async () => true },
    })
    expect(seeds[1]).toContain("counterfactual minimal alternative")
    // cand2 keeps its owner-focus seed — diversity preserved, not a 2nd copy.
    expect(seeds[2]).toBe("OWNER-2-SEED")
  })

  it("does NOT list a counterfactual cand1 in telemetry when dedup collapses it onto cand0", async () => {
    // cand1 produces the IDENTICAL patch as cand0 ⇒ deduped out of `scored`.
    const { gen } = recordingGen([
      cand({ id: "cand-0", patch: diff2, files: [OWNER, OTHER] }),
      cand({ id: "cand-1", patch: diff2, files: [OWNER, OTHER] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([OWNER]),
      counterfactual: true,
      riskGate: async (c) => expandDecisionFor(c.patch),
      ports: { generate: gen, applyClean: async () => true },
    })
    expect(r.counterfactual?.candidateIds).not.toContain("cand-1")
    expect(r.generated).toBe(1)
  })
})

describe("counterfactual select — contract gate (T-301)", () => {
  it("bars a contract-VIOLATING counterfactual cand1 from winning over cand0", async () => {
    // cand1 violates the singleOwnerFile contract (still two source files) but is
    // a DISTINCT patch from cand0 so it is not deduped before scoring.
    const violatingDiff = `${diff1(OWNER)}\n${diff1("pkg/third.py")}`
    const { gen } = recordingGen([
      cand({ id: "cand-0", patch: diff2, files: [OWNER, OTHER] }),
      cand({ id: "cand-1", patch: violatingDiff, files: [OWNER, "pkg/third.py"] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([OWNER]),
      counterfactual: true,
      riskGate: async (c) => expandDecisionFor(c.patch),
      ports: { generate: gen, applyClean: async () => true },
    })
    expect(r.winner?.id).not.toBe("cand-1")
    expect(r.counterfactual?.violatedCandidateIds).toContain("cand-1")
    expect(r.counterfactual?.contracts).toContain("singleOwnerFile")
  })

  it("a contract-HONORING counterfactual cand1 stays eligible to win", async () => {
    const { gen } = recordingGen([
      cand({ id: "cand-0", patch: diff2, files: [OWNER, OTHER] }),
      // cand1 honors singleOwnerFile (one owner file) ⇒ better owner-coverage.
      cand({ id: "cand-1", patch: diff1(OWNER), files: [OWNER] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([OWNER]),
      counterfactual: true,
      riskGate: async (c) => expandDecisionFor(c.patch),
      ports: { generate: gen, applyClean: async () => true },
    })
    expect(r.counterfactual?.violatedCandidateIds).toEqual([])
    expect(r.winner?.id).toBe("cand-1")
  })

  it("binds cand1 to the seeded owner file, not any file in the owner set", async () => {
    const seededOwner = OWNER
    const otherOwner = OWNER2
    const decision: SelectionRiskGateDecision = {
      expand: true,
      reasons: ["patch-budget:source-file budget=1"],
      patchBudget: analyzePatchBudget(diff2, {
        ownerFiles: [seededOwner, otherOwner],
        runtimeExpandingPolicy: "gate",
      }),
    }
    const { gen } = recordingGen([
      cand({ id: "cand-0", patch: diff2, files: [seededOwner, OTHER] }),
      cand({ id: "cand-1", patch: diff1(otherOwner), files: [otherOwner] }),
    ])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([seededOwner, otherOwner]),
      counterfactual: true,
      riskGate: async () => decision,
      ports: { generate: gen, applyClean: async () => true },
    })
    expect(r.winner?.id).not.toBe("cand-1")
    expect(r.counterfactual?.violatedCandidateIds).toContain("cand-1")
    expect(r.counterfactual?.contracts).toContain("singleOwnerFile")
  })
})

describe("counterfactual select — cheap validation accept (T-101)", () => {
  it("probes applyClean on a low-risk cand0 and refuses to crown a dirty patch", async () => {
    let applyCalls = 0
    const { gen } = recordingGen([cand({ id: "cand-0" })])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([OWNER]),
      counterfactual: true,
      riskGate: async () => ({ expand: false, reasons: [] }),
      ports: {
        generate: gen,
        applyClean: async () => {
          applyCalls += 1
          return false
        },
      },
    })
    expect(applyCalls).toBeGreaterThanOrEqual(1)
    expect(r.winner).toBeNull()
    expect(r.terminalCandidate?.id).toBe("cand-0")
  })

  it("RED-ON-INJECTION: legacy arm static-accepts WITHOUT probing applyClean", async () => {
    let applyCalls = 0
    const { gen } = recordingGen([cand({ id: "cand-0" })])
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([OWNER]),
      // counterfactual omitted ⇒ legacy static accept (cost-saving, no probe)
      riskGate: async () => ({ expand: false, reasons: [] }),
      ports: {
        generate: gen,
        applyClean: async () => {
          applyCalls += 1
          return false
        },
      },
    })
    expect(applyCalls).toBe(0)
    expect(r.winner?.id).toBe("cand-0")
  })

  it("fails closed when counterfactual-select is combined with concurrency > 1", async () => {
    const { gen } = recordingGen([cand({ id: "cand-0" }), cand({ id: "cand-1" })])
    await expect(
      runSelection({
        n: 2,
        concurrency: 2,
        seeds: [undefined, undefined],
        owners: new Set([OWNER]),
        counterfactual: true,
        riskGate: async () => ({ expand: false, reasons: [] }),
        ports: { generate: gen, applyClean: async () => true },
      }),
    ).rejects.toThrow("verify-select-counterfactual requires verify-select-concurrency=1")
  })
})
