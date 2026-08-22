/**
 * Hellgate — fc reachability OVERCLAIM FLOOR (ALBB-15 root fix).
 *
 * The manual "don't overclaim maturity" policy, turned into an ENFORCED
 * import-graph gate. `computeReachabilityOffenders` must flag ANY feature at
 * `maturity >= L3` whose declared `evidence.code` src files are ALL dead
 * (unreachable via the real import/re-export graph) — not just L4/L5.
 *
 * Keyword-FREE by construction: the offender verdict is a pure function of the
 * injected `reached` set (the real graph) + the feature's declared src list.
 * No string/keyword match on the feature is possible here (the fixture varies
 * ONLY the maturity + the reached set).
 *
 *   FLOOR-01  L3 slice, all src unreachable ⇒ OFFENDER (the bug this fixes).
 *   FLOOR-02  MUTATION — raise the floor back to L4 ⇒ the SAME L3 slice is
 *             NOT flagged (proves the floor, not a keyword, is load-bearing).
 *   FLOOR-03  L3 slice with ONE reachable src ⇒ NOT an offender (the legit
 *             partially-wired L3, e.g. objective-budget-enforce, is spared).
 *   FLOOR-04  L1/L2 scaffold ⇒ NEVER flagged even fully unreachable.
 *   FLOOR-05  the DEFAULT floor is L3 (regression pin on REACHABILITY_FLOOR).
 */

import { describe, expect, test } from "bun:test"
import {
  computeReachabilityOffenders,
  type LoadedFeature,
  maturityRank,
  REACHABILITY_FLOOR,
} from "../../tools/feature-catalog/cli"

/** Minimal LoadedFeature fixture — the offender computer reads ONLY
 *  `feature.id`, `feature.maturity`, `feature.evidence.code`. */
const mkFeature = (id: string, maturity: string, code: string[]): LoadedFeature =>
  ({
    path: `tools/feature-catalog/features/synthetic/${id}.yaml`,
    feature: {
      id,
      maturity,
      evidence: { code, adrs: [], tests: { unit: [], integration: [], contract: [] } },
    },
  }) as unknown as LoadedFeature

const DEAD_SRC = "src/agent/lane-manager/default-manager.ts"
const LIVE_SRC = "src/agent/loop.ts"

// A graph where DEAD_SRC is NOT reached and LIVE_SRC is.
const reach = { reached: new Set<string>([LIVE_SRC]) }

describe("fc reachability floor — L3 overclaim hard-gate (ALBB-15)", () => {
  test("FLOOR-01: an L3 slice whose src is all unreachable is an OFFENDER", () => {
    const feats = [mkFeature("orphan-l3", "L3", [DEAD_SRC])]
    const offenders = computeReachabilityOffenders(feats, reach, null)
    expect(offenders.map((o) => o.id)).toContain("orphan-l3")
    const o = offenders.find((x) => x.id === "orphan-l3")
    expect(o?.kind).toBe("unreachable")
  })

  test("FLOOR-02: MUTATION — raising the floor back to L4 spares the same L3 slice", () => {
    const feats = [mkFeature("orphan-l3", "L3", [DEAD_SRC])]
    // Floor=L4 is the OLD (buggy) behaviour — the L3 orphan must escape then.
    const l4 = computeReachabilityOffenders(feats, reach, null, "L4")
    expect(l4.map((o) => o.id)).not.toContain("orphan-l3")
    // …and the default (L3) floor catches it. RED-on-injection proven: only the
    // floor changed, so a keyword can't be responsible.
    const l3 = computeReachabilityOffenders(feats, reach, null)
    expect(l3.map((o) => o.id)).toContain("orphan-l3")
  })

  test("FLOOR-03: an L3 slice with ANY reachable src is NOT an offender (legit partial wiring)", () => {
    const feats = [mkFeature("partial-l3", "L3", [DEAD_SRC, LIVE_SRC])]
    const offenders = computeReachabilityOffenders(feats, reach, null)
    expect(offenders.map((o) => o.id)).not.toContain("partial-l3")
  })

  test("FLOOR-04: L1/L2 scaffold slices are NEVER flagged even fully unreachable", () => {
    const feats = [
      mkFeature("scaffold-l1", "L1", [DEAD_SRC]),
      mkFeature("principle-l2", "L2", [DEAD_SRC]),
    ]
    const offenders = computeReachabilityOffenders(feats, reach, null)
    expect(offenders.length).toBe(0)
  })

  test("FLOOR-05: default floor is L3", () => {
    expect(REACHABILITY_FLOOR).toBe("L3")
    expect(maturityRank("L3")).toBe(3)
    expect(maturityRank("L2")).toBeLessThan(maturityRank("L3"))
  })
})
