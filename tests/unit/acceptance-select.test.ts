/**
 * Phase A — acceptance orchestrator (SOTA++ keystone seam).
 *
 * Composes the two pure cores — `acceptance-rerank` (patch vote + 3-tier ladder)
 * and the per-candidate acceptance ORACLES (reproduction boolean, regression
 * failure count) — into ONE gated orchestrator. The oracles are injected ports
 * (the driver wires them to the real sandbox; tests use fakes), so this seam is
 * hermetic-by-injection and the available oracles decide the rerank mode:
 *   runRepro + runRegression ⇒ dual-guard
 *   runRepro only            ⇒ repro-only
 *   neither                  ⇒ pure patch vote (tier 3)
 *
 * Each candidate is scored ONCE (the anti-pattern this replaces re-voted the repro
 * set every repair round). `scored[]` carries the per-candidate verdicts for RCA.
 */

import { describe, expect, test } from "bun:test"
import {
  type AcceptanceCandidate,
  type AcceptanceOracles,
  selectByAcceptance,
} from "../../src/runner/batch/eval/acceptance-select"

const cand = (patch: string, key = patch): AcceptanceCandidate => ({ patch, patchKey: key })

describe("selectByAcceptance — score-once + rerank", () => {
  test("dual-guard: picks the repro-pass + min-regression majority patch", async () => {
    const repro: Record<string, boolean> = { A: true, B: true, C: false }
    const regr: Record<string, number> = { A: 0, B: 0, C: 0 }
    const oracles: AcceptanceOracles = {
      runRepro: async (c) => repro[c.patch] ?? false,
      runRegression: async (c) => regr[c.patch] ?? 0,
    }
    const r = await selectByAcceptance([cand("A"), cand("A"), cand("B"), cand("C")], oracles)
    expect(r.selected.patch).toBe("A") // A: 2 votes, repro+reg pass
    expect(r.selected.tier).toBe("repro_and_regression")
    expect(r.scored).toHaveLength(4)
  })

  test("repro fails ⇒ that candidate excluded even with more copies", async () => {
    const oracles: AcceptanceOracles = {
      runRepro: async (c) => c.patch === "B",
      runRegression: async () => 0,
    }
    const r = await selectByAcceptance([cand("A"), cand("A"), cand("A"), cand("B")], oracles)
    expect(r.selected.patch).toBe("B")
  })

  test("repro-only (no regression oracle) ⇒ reproduction guard, regression off", async () => {
    const oracles: AcceptanceOracles = { runRepro: async (c) => c.patch === "X" }
    const r = await selectByAcceptance([cand("X"), cand("Y")], oracles)
    expect(r.selected.patch).toBe("X")
    expect(r.scored.every((s) => s.regressionFailures === 0)).toBe(true)
  })

  test("no oracles ⇒ pure patch majority vote (tier 3)", async () => {
    const r = await selectByAcceptance([cand("A"), cand("B"), cand("B")], {})
    expect(r.selected.patch).toBe("B")
    expect(r.selected.tier).toBe("all_patches")
  })

  test("each candidate is scored EXACTLY once (no per-round re-vote)", async () => {
    const reproCalls: string[] = []
    const regrCalls: string[] = []
    const oracles: AcceptanceOracles = {
      runRepro: async (c) => {
        reproCalls.push(c.patch)
        return true
      },
      runRegression: async (c) => {
        regrCalls.push(c.patch)
        return 0
      },
    }
    await selectByAcceptance([cand("A"), cand("B"), cand("C")], oracles)
    expect(reproCalls).toEqual(["A", "B", "C"])
    expect(regrCalls).toEqual(["A", "B", "C"])
  })

  test("scored[] carries per-candidate verdicts for RCA", async () => {
    const oracles: AcceptanceOracles = {
      runRepro: async (c) => c.patch === "A",
      runRegression: async (c) => (c.patch === "A" ? 0 : 2),
    }
    const r = await selectByAcceptance([cand("A"), cand("B")], oracles)
    expect(r.scored[0]).toMatchObject({
      index: 0,
      patch: "A",
      reproPass: true,
      regressionFailures: 0,
    })
    expect(r.scored[1]).toMatchObject({
      index: 1,
      patch: "B",
      reproPass: false,
      regressionFailures: 2,
    })
  })

  test("empty candidate set ⇒ tier none, empty patch", async () => {
    const r = await selectByAcceptance([], { runRepro: async () => true })
    expect(r.selected.patch).toBe("")
    expect(r.selected.tier).toBe("none")
  })

  test("DEGRADE: a throwing repro oracle on ONE candidate does not abort selection", async () => {
    const oracles: AcceptanceOracles = {
      runRepro: async (c) => {
        if (c.patch === "B") throw new Error("sandbox crash on B")
        return true
      },
    }
    // B's oracle throws ⇒ B degrades to repro=false (loses); A still wins. No throw.
    const r = await selectByAcceptance([cand("A"), cand("B")], oracles)
    expect(r.selected.patch).toBe("A")
    expect(r.scored[1]).toMatchObject({ patch: "B", reproPass: false })
  })

  test("DEGRADE: a throwing regression oracle ⇒ +Infinity failures (loses min bar)", async () => {
    const oracles: AcceptanceOracles = {
      runRepro: async () => true,
      runRegression: async (c) => {
        if (c.patch === "B") throw new Error("regression run crashed")
        return 0
      },
    }
    const r = await selectByAcceptance([cand("A"), cand("B")], oracles)
    expect(r.selected.patch).toBe("A") // A has 0 failures; B degraded to Infinity
    expect(r.scored[1]?.regressionFailures).toBe(Number.POSITIVE_INFINITY)
  })
})
