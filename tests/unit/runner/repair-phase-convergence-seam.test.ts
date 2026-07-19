import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Convergence-seam guard (jun-30 hellaudit follow-up; jul-15 dead-orchestrator
 * cleanup).
 *
 * The bench repair phase runs on the shared exported helpers
 * `buildRepairBreadthRunCandidates` + `runRepairRoundsInSnapshot` (commit
 * e505cef9a). The runner core USED to also carry a per-instance `runRepairPhase`
 * orchestrator; that duplicate had ZERO runtime callers (the app driver is the
 * live orchestrator) and was deleted (D3). The runner core is now purely the
 * shared LIBRARY. This pins the surviving seam:
 *   1. The app orchestrator must DELEGATE to the shared helpers (re-inlining the
 *      breadth / snapshot block back into the app driver = the duplication we
 *      removed → RED).
 *   2. The runner core DEFINES + EXPORTS the shared helpers (single SSOT) and no
 *      longer duplicates the per-instance orchestrator (deletion guard).
 *
 * Robust by construction: the delegation is scoped to the app driver's
 * `runRepairPhase` region (not the whole file).
 */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
// The runner core's shared breadth/snapshot helpers live in
// `./driver/repair-phase.ts` (jul-02 god-file split — pure code motion). The
// runner core `driver.ts` RE-EXPORTS them from that module (see the
// `export … from "./driver/repair-phase"` barrel). Point the runner-side
// assertions at the module that actually owns the code.
const RUNNER = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver/repair-phase.ts"), "utf8")
const RUNNER_BARREL = readFileSync(join(REPO_ROOT, "src/runner/batch/eval/driver.ts"), "utf8")
const APP = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

/** Slice the app driver's `runRepairPhase` region: from the `runRepairPhase`
 *  marker to the next top-level `const`/`export const` (column-0). The runner
 *  core's per-instance repair ORCHESTRATOR was deleted as dead (only the shared
 *  breadth/snapshot LIBRARY survives there); the app driver is now the SOLE
 *  repair-phase orchestrator, so only its region is sliced for delegation. */
const repairPhaseRegion = (src: string, startMarker: string): string => {
  const start = src.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start + 1)
  const endRel = rest.search(/\n(?:export )?const \w+ = /)
  return endRel === -1 ? rest : rest.slice(0, endRel)
}

const APP_REGION = repairPhaseRegion(APP, "const runRepairPhase = async (")

describe("repair-phase convergence seam (shared helpers, single SSOT)", () => {
  test("the app orchestrator delegates runRepairPhase to the shared breadth + snapshot helpers", () => {
    // Re-inlining either block back into the app driver (the duplication the
    // convergence removed) drops the delegating call → RED.
    expect(APP_REGION).toContain("buildRepairBreadthRunCandidates({")
    expect(APP_REGION).toContain("runRepairRoundsInSnapshot({")
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

  test("the runner core no longer duplicates the per-instance repair orchestrator", () => {
    // Guard the deletion: the dead runner-core `runRepairPhase` /
    // `buildRepairPhaseInputs` orchestrator pair must not creep back in — the
    // runner core owns only the shared LIBRARY, the app owns orchestration.
    expect(RUNNER).not.toContain("export const runRepairPhase")
    expect(RUNNER).not.toContain("const buildRepairPhaseInputs")
  })
})
