import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Convergence-seam guard (jun-30 hellaudit follow-up).
 *
 * The two bench drivers' `runRepairPhase` were converged onto the shared exported
 * helpers `buildRepairBreadthRunCandidates` + `runRepairRoundsInSnapshot` (commit
 * e505cef9a). The adversarial audit confirmed the convergence was behaviour-
 * identical, but flagged that NO test defended the seam — so a future edit to the
 * per-driver `runAgentOnFork` / `runOnce` closures (the only intended divergence:
 * the runner threads `chaMultisiteSteer` into the repair agent, the app does not)
 * would land SILENTLY GREEN. This pins exactly that seam:
 *   1. BOTH drivers must DELEGATE to the shared helpers (re-inlining the breadth /
 *      snapshot block back into a driver = the duplication we removed → RED).
 *   2. The runner MUST thread `chaMultisiteSteer` into its repair-agent closures;
 *      the app MUST NOT (the sole documented divergence).
 *
 * Robust by construction: scoped to the `runRepairPhase` region (not the whole
 * file, which has other `chaMultisiteSteer` sites), and the divergence is counted
 * via `chaMultisiteSteer,` — a trailing-comma CALL ARGUMENT, immune to the doc
 * comments that mention the word without a comma.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const RUNNER = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")
const APP = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

/** Slice the `runRepairPhase` function body out of a driver source: from its
 *  declaration to the next top-level `const`/`export const` (column-0). */
const repairPhaseRegion = (src: string): string => {
  const start = src.indexOf("const runRepairPhase = async (")
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start + 1)
  const endRel = rest.search(/\n(?:export )?const \w+ = /)
  return endRel === -1 ? src.slice(start) : rest.slice(0, endRel)
}

const countOccurrences = (hay: string, needle: string): number => hay.split(needle).length - 1

describe("repair-phase convergence seam (shared helpers + chaMultisiteSteer divergence)", () => {
  test("BOTH drivers delegate runRepairPhase to the shared breadth + snapshot helpers", () => {
    for (const region of [repairPhaseRegion(RUNNER), repairPhaseRegion(APP)]) {
      // Re-inlining either block back into a driver (the duplication the
      // convergence removed) drops the delegating call → RED.
      expect(region).toContain("buildRepairBreadthRunCandidates({")
      expect(region).toContain("runRepairRoundsInSnapshot({")
    }
  })

  test("runner threads chaMultisiteSteer into its repair-agent closures; app does NOT", () => {
    // `chaMultisiteSteer,` = a trailing-comma call argument (NOT the doc comments,
    // which mention the bare word). The runner passes it in BOTH the breadth fork
    // closure and the runOnce closure (2); the app omits it entirely (0) — the
    // sole intended per-driver divergence. Drift either way is now RED, not silent.
    expect(countOccurrences(repairPhaseRegion(RUNNER), "chaMultisiteSteer,")).toBe(2)
    expect(countOccurrences(repairPhaseRegion(APP), "chaMultisiteSteer,")).toBe(0)
  })

  test("the shared helpers are exported from the runner core driver (the single SSOT)", () => {
    expect(RUNNER).toContain("export const buildRepairBreadthRunCandidates")
    expect(RUNNER).toContain("export const runRepairRoundsInSnapshot")
    // The app driver imports them rather than defining its own (no re-duplication).
    expect(APP).not.toContain("const buildRepairBreadthRunCandidates =")
    expect(APP).not.toContain("const runRepairRoundsInSnapshot =")
  })
})
