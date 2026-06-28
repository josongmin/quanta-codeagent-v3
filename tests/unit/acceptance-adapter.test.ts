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
import type { AcceptanceOracles } from "../../src/runner/batch/eval/acceptance-select"
import type { RepairCandidateOutcome } from "../../src/runner/batch/eval/repair/types"

const outcome = (patch: string): RepairCandidateOutcome => ({
  run: { patch, turns: 1 },
  validator: { ok: false },
  adopt: async () => {},
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

  test("degenerate: empty candidate list ⇒ no throw (returns undefined-safe)", async () => {
    // The orchestrator never calls with an empty list (it guards length), but the
    // adapter must not NPE if it ever does.
    const winner = await buildAcceptanceSelector({ runRepro: async () => true })([])
    expect(winner).toBeUndefined()
  })
})
