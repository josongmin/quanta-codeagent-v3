/**
 * jun-28 SOTA++ Phase-A — acceptance selector ADAPTER.
 *
 * Bridges the orchestrator's `RepairCandidateOutcome[]` world to the acceptance
 * world: maps each candidate's cumulative patch into an AcceptanceCandidate,
 * scores once via the injected oracles, rerank-selects, and maps the winner BACK
 * to its `RepairCandidateOutcome` (so the orchestrator can `.adopt()` it). This is
 * exactly the `selectCandidates` port the driver injects behind the opt-in.
 */

import { describe, expect, test } from "bun:test"
import { buildAcceptanceSelector } from "../../src/runner/batch/eval/acceptance-adapter"
import {
  type AcceptanceOracles,
  type AcceptanceSelectionTelemetry,
  attributeAcceptanceTier,
} from "../../src/runner/batch/eval/acceptance-select"
import type { RepairCandidateOutcome } from "../../src/runner/batch/eval/repair/types"

const outcome = (
  patch: string,
  extra: Partial<RepairCandidateOutcome> = {},
): RepairCandidateOutcome => ({
  run: { patch, turns: 1 },
  validator: { ok: false },
  adopt: async () => {},
  ...extra,
})

describe("buildAcceptanceSelector — RepairCandidateOutcome bridge", () => {
  test("scores by patch and returns the WINNING candidate outcome (adoptable)", async () => {
    const oracles: AcceptanceOracles = {
      runRepro: async (c) => c.patch === "P2",
      runRegression: async () => 0,
    }
    const cands = [outcome("P1"), outcome("P2"), outcome("P3")]
    const select = buildAcceptanceSelector(oracles)
    const winner = await select(cands)
    expect(winner === cands[1]).toBe(true) // the SAME object ⇒ orchestrator can adopt it
    expect(winner.run.patch).toBe("P2")
  })

  test("the returned outcome is always one of the inputs (orchestrator can adopt)", async () => {
    const cands = [outcome("A"), outcome("B")]
    const winner = await buildAcceptanceSelector({ runRepro: async () => true })(cands)
    expect(cands.includes(winner)).toBe(true)
  })

  test("injected normalize is used as the vote key (canonical dedup)", async () => {
    // P1a and P1b normalize to the same key ⇒ 2 votes ⇒ beat the singleton P2.
    const norm = (p: string) => (p.startsWith("P1") ? "P1" : p)
    const oracles: AcceptanceOracles = { runRepro: async () => true }
    const cands = [outcome("P1a"), outcome("P1b"), outcome("P2")]
    const winner = await buildAcceptanceSelector(oracles, norm)(cands)
    // first P1* (the canonical group's first appearance) wins on votes.
    expect(winner.run.patch).toBe("P1a")
  })

  test("oracle runs once per candidate (no per-round re-vote)", async () => {
    const seen: string[] = []
    const oracles: AcceptanceOracles = {
      runRepro: async (c) => {
        seen.push(c.patch)
        return true
      },
    }
    await buildAcceptanceSelector(oracles)([outcome("A"), outcome("B"), outcome("C")])
    expect(seen).toEqual(["A", "B", "C"])
  })

  test("acceptance tie on votes/oracles prefers the structurally complete family candidate", async () => {
    const cands = [
      outcome("PARTIAL", {
        familyId: "multi-site",
        familyCoverageMissing: ["pkg/peer.py"],
      }),
      outcome("COMPLETE", {
        familyId: "multi-site",
        familyCoverageMissing: [],
      }),
    ]
    const winner = await buildAcceptanceSelector({ runRepro: async () => true })(cands)
    expect(winner.run.patch).toBe("COMPLETE")
    expect(winner === cands[1]).toBe(true)
  })

  test("empty candidate list ⇒ THROWS (contract violation, not a cast-masked undefined)", async () => {
    // The orchestrator guards length>0 before calling; an empty list is a contract
    // breach — throw loudly rather than return undefined that NPEs at winner.adopt().
    await expect(buildAcceptanceSelector({ runRepro: async () => true })([])).rejects.toThrow(
      "empty candidate list",
    )
  })
})

describe("buildAcceptanceSelector — onSelection tier telemetry (observe-only)", () => {
  test("emits the DUAL-GUARD tier when both oracles filter (repro + regression)", async () => {
    // repro+regression present, P2 alone passes both ⇒ tier-1 selection did REAL work.
    const oracles: AcceptanceOracles = {
      runRepro: async (c) => c.patch === "P2",
      runRegression: async () => 0,
    }
    let seen: AcceptanceSelectionTelemetry | undefined
    const winner = await buildAcceptanceSelector(oracles, undefined, undefined, (t) => {
      seen = t
    })([outcome("P1"), outcome("P2"), outcome("P3")])
    expect(winner.run.patch).toBe("P2")
    expect(seen).toEqual({
      tier: "repro_and_regression",
      votes: 1,
      candidateCount: 3,
      llmOverrode: false,
      winningPatch: "P2",
    })
    // Revert-proof: dropping the onSelection call would leave `seen` undefined.
  })

  test("emits all_patches (the INERT canary) when NO oracle is available", async () => {
    // No oracles ⇒ ladder falls through to a pure vote ⇒ tier-3 = no real selection.
    let seen: AcceptanceSelectionTelemetry | undefined
    await buildAcceptanceSelector({}, undefined, undefined, (t) => {
      seen = t
    })([outcome("A"), outcome("B")])
    expect(seen?.tier).toBe("all_patches")
    // Revert-proof: if the adapter passed `opts.reproduction` true when no oracle was
    // wired, this would mis-report a working tier instead of the inert canary.
  })

  test("emits regression_only when only the regression oracle is wired", async () => {
    let seen: AcceptanceSelectionTelemetry | undefined
    await buildAcceptanceSelector({ runRegression: async () => 0 }, undefined, undefined, (t) => {
      seen = t
    })([outcome("A"), outcome("B")])
    expect(seen?.tier).toBe("regression_only")
  })

  test("a THROWING onSelection sink never sinks the round (swallowed)", async () => {
    // observe-only contract: telemetry failure must not crash the repair round.
    const cands = [outcome("A"), outcome("B")]
    const winner = await buildAcceptanceSelector(
      { runRepro: async () => true },
      undefined,
      undefined,
      () => {
        throw new Error("telemetry sink boom")
      },
    )(cands)
    expect(cands.includes(winner)).toBe(true) // selection survived the throwing sink
  })

  test("absent onSelection ⇒ byte-identical (no telemetry, winner unchanged)", async () => {
    // Default-OFF fence: the legacy 3-arg call shape still selects identically.
    const cands = [outcome("A"), outcome("B")]
    const winner = await buildAcceptanceSelector({ runRepro: async (c) => c.patch === "B" })(cands)
    expect(winner.run.patch).toBe("B")
  })
})

describe("attributeAcceptanceTier — staleness guard (submitted-patch correlation)", () => {
  test("attributes the tier when the last selection's winner IS the submitted patch", () => {
    const tier = attributeAcceptanceTier(
      { tier: "regression_only", winningPatch: "FINAL" },
      "FINAL",
    )
    expect(tier).toBe("regression_only")
  })

  test("does NOT attribute when a trailing fallback changed the submitted patch", () => {
    // The bug this guards: round N selected (tier set), round N+1 fell back to a
    // non-selected runOnce patch ⇒ submitted patch ≠ last selection's winner ⇒ the
    // stale tier must NOT be attributed to a patch acceptance never chose.
    const tier = attributeAcceptanceTier(
      { tier: "repro_and_regression", winningPatch: "ROUND_N_WINNER" },
      "FALLBACK_RUNONCE_PATCH",
    )
    expect(tier).toBeUndefined()
  })

  test("no selection ran (breadth=1 / acceptance off) ⇒ undefined", () => {
    expect(attributeAcceptanceTier(undefined, "ANY")).toBeUndefined()
  })
})
