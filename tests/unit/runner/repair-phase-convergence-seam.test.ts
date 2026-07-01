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
// The runner core's `runRepairPhase` + the shared breadth/snapshot helpers were
// extracted (jul-02 god-file split) into `./driver/repair-phase.ts` — pure code
// motion. The runner core `driver.ts` now RE-EXPORTS the helpers from that module
// (see the `export … from "./driver/repair-phase"` barrel). Point the runner-side
// assertions at the module that actually owns the code; the invariant (single SSOT,
// app delegates + omits chaMultisiteSteer) is unchanged.
const RUNNER = readFileSync(
  join(REPO_ROOT, "src/runner/batch/eval/driver/repair-phase.ts"),
  "utf8",
)
const RUNNER_BARREL = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")
const APP = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

/** Slice the repair-phase region out of a driver source: from `startMarker` to
 *  the next top-level `const`/`export const` after the LAST such marker (column-0).
 *
 *  The runner core's repair phase was split (jul-02 god-FN reduction) into
 *  `buildRepairPhaseInputs` (owns the breadth-fork closure) + `runRepairPhase`
 *  (owns the runOnce closure) — so for the runner the region must START at
 *  `buildRepairPhaseInputs` to span BOTH. The app driver keeps the whole thing
 *  inline under `runRepairPhase`, so its start marker is `runRepairPhase`. */
const repairPhaseRegion = (src: string, startMarker: string): string => {
  const start = src.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start + 1)
  // Walk to the last top-level decl that is NOT part of the repair-phase pair,
  // i.e. the first top-level `const`/`export const` AFTER `runRepairPhase`'s body.
  const runIdx = rest.indexOf("runRepairPhase = async (")
  const afterRun = runIdx === -1 ? rest : rest.slice(runIdx)
  const endRel = afterRun.search(/\n(?:export )?const \w+ = /)
  const tail = endRel === -1 ? afterRun : afterRun.slice(0, endRel)
  return runIdx === -1 ? tail : rest.slice(0, runIdx) + tail
}

const RUNNER_REGION = repairPhaseRegion(RUNNER, "const buildRepairPhaseInputs = ")
const APP_REGION = repairPhaseRegion(APP, "const runRepairPhase = async (")

const countOccurrences = (hay: string, needle: string): number => hay.split(needle).length - 1

describe("repair-phase convergence seam (shared helpers + chaMultisiteSteer divergence)", () => {
  test("BOTH drivers delegate runRepairPhase to the shared breadth + snapshot helpers", () => {
    for (const region of [RUNNER_REGION, APP_REGION]) {
      // Re-inlining either block back into a driver (the duplication the
      // convergence removed) drops the delegating call → RED.
      expect(region).toContain("buildRepairBreadthRunCandidates({")
      expect(region).toContain("runRepairRoundsInSnapshot({")
    }
  })

  test("runner threads chaMultisiteSteer into its repair-agent closures; app does NOT", () => {
    // `chaMultisiteSteer,` = a trailing-comma call argument (NOT the doc comments,
    // which mention the bare word). The runner passes it into BOTH repair-agent
    // closures — the breadth fork (in `buildRepairPhaseInputs`) and the runOnce
    // closure (in `runRepairPhase`) — plus, post-split, one plumbing arg on the
    // `buildRepairPhaseInputs(...)` delegation (3 total in the combined region).
    // The app omits it entirely (0) — the sole intended per-driver divergence.
    // Drift either way is now RED, not silent.
    expect(countOccurrences(RUNNER_REGION, "chaMultisiteSteer,")).toBe(3)
    expect(countOccurrences(APP_REGION, "chaMultisiteSteer,")).toBe(0)
  })

  test("the shared helpers are exported from the runner core driver (the single SSOT)", () => {
    expect(RUNNER).toContain("export const buildRepairBreadthRunCandidates")
    expect(RUNNER).toContain("export const runRepairRoundsInSnapshot")
    // The runner core `driver.ts` barrel still re-exports the helpers (public
    // surface preserved for apps/bench + tests) from the extracted module.
    expect(RUNNER_BARREL).toContain("buildRepairBreadthRunCandidates")
    expect(RUNNER_BARREL).toContain("runRepairRoundsInSnapshot")
    expect(RUNNER_BARREL).toContain('from "./driver/repair-phase"')
    // The app driver imports them rather than defining its own (no re-duplication).
    expect(APP).not.toContain("const buildRepairBreadthRunCandidates =")
    expect(APP).not.toContain("const runRepairRoundsInSnapshot =")
  })
})
