/**
 * Adaptive-timeout DEAD-FEATURE guard.
 *
 * The knob-`costMultiplier` wall-clock scaling (`computeAdaptedTimeout` +
 * `sumCostMultipliers` + `MAX_TIMEOUT_MS`, formerly in
 * `src/runner/batch/eval/adaptive-timeout.ts`) was built but never wired into
 * any PRODUCTION path:
 *
 *   - The live bench entry-point is `runInstance` in
 *     `src/apps/bench/eval/driver.ts` (re-exported through
 *     `src/apps/bench/eval/index.ts`, imported by `src/apps/bench/index.ts`).
 *     That twin DELIBERATELY uses `deps.timeoutMs` verbatim — knob
 *     `costMultiplier` is a matrix-budget construct (e.g. repro-test=40) and
 *     using it as a wall-clock multiplier would balloon an `agentless-v1`
 *     instance ~15×.
 *   - The only caller of `computeAdaptedTimeout` was the runner-core
 *     `runInstance` twin, which the codebase documents as having no production
 *     caller.
 *
 * The module + its scaling logic were therefore DELETED. This file replaces
 * the old pure-projection unit tests with a structural ratchet so the dead
 * feature cannot silently reappear (red-on-injection):
 *
 *   1. the orphan module file must not exist;
 *   2. the runner-core driver must not re-export the adaptive-timeout symbols;
 *   3. neither driver source may import / call `computeAdaptedTimeout`.
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

// Repo root: this file lives at <root>/tests/unit/runner/adaptive-timeout.test.ts.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const RUNNER_DRIVER = join(REPO_ROOT, "src/runner/batch/eval/driver.ts")
const APPS_DRIVER = join(REPO_ROOT, "src/apps/bench/eval/driver.ts")
const ORPHAN_MODULE = join(REPO_ROOT, "src/runner/batch/eval/adaptive-timeout.ts")

const DEAD_SYMBOLS = ["computeAdaptedTimeout", "sumCostMultipliers"] as const

describe("adaptive-timeout dead-feature guard", () => {
  test("orphan module src/runner/batch/eval/adaptive-timeout.ts is deleted", () => {
    expect(existsSync(ORPHAN_MODULE)).toBe(false)
  })

  test("runner-core driver no longer re-exports the dead adaptive-timeout symbols", async () => {
    const mod = (await import("@/runner/batch/eval/driver")) as Record<string, unknown>
    for (const sym of DEAD_SYMBOLS) {
      expect(mod[sym]).toBeUndefined()
    }
    // MAX_TIMEOUT_MS was the dead cap constant — must not be re-exported either.
    expect(mod.MAX_TIMEOUT_MS).toBeUndefined()
  })

  test("neither bench driver imports or calls computeAdaptedTimeout", async () => {
    for (const path of [RUNNER_DRIVER, APPS_DRIVER]) {
      const src = await Bun.file(path).text()
      expect(src).not.toContain("computeAdaptedTimeout")
      expect(src).not.toContain("adaptive-timeout")
    }
  })

  test("production runInstance budget reports the operator timeout verbatim (no costMultiplier scaling)", async () => {
    // The live twin must never multiply the wall-clock by a knob cost. We pin
    // the source-level contract: the apps driver stamps `adaptedTimeoutMs`
    // straight from `deps.timeoutMs`, not from any sum-of-costMultipliers
    // expression. (Driving runInstance end-to-end needs a sandbox; the source
    // contract is the load-bearing red-on-injection signal here.)
    const src = await Bun.file(APPS_DRIVER).text()
    // The scaling formula `Σ(costMultiplier)` × base must be absent.
    expect(src).not.toContain("sumCostMultipliers")
    // The budget stamp must source adaptedTimeoutMs from deps.timeoutMs.
    expect(src).toContain("adaptedTimeoutMs: deps.timeoutMs")
  })
})
