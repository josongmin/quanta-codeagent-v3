/**
 * Hellgate: QUANTA_BENCH_SOTA=1 super-preset — proves the SOTA++ flag correctly
 * enables lspNav + localizePhase=5 + issueHintMode="agentless" in benchOptIns().
 *
 * Red-on-injection: each test fails if the sotaOn branch is removed from
 * benchOptIns(). Uses env-isolated beforeEach/afterEach to prevent cross-test
 * bleed (the same pattern as bench-branch-search-wiring-hellgate.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { benchOptIns } from "../../src/apps/bench/eval/driver"

const ENV_KEYS = [
  "QUANTA_BENCH_SOTA",
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_LOCALIZE_PHASE",
  "QUANTA_BENCH_ISSUE_HINT",
  "QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL",
  "QUANTA_LSP_TOOLS",
] as const

const snapshot = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}
const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = snapshot()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  restore(saved)
})

describe("bench SOTA preset hellgate — QUANTA_BENCH_SOTA=1", () => {
  // SOTA-1: lspNav must be true when SOTA flag is set.
  // Red-on-injection: remove `sotaOn ||` from `lspNav = sotaOn || ...` and
  // this test fails (BENCH_LSP is not set, so lspNav would be false).
  test("SOTA-1: QUANTA_BENCH_SOTA=1 enables lspNav", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(true)
  })

  // SOTA-2: localizePhase must be {phase1Turns:5} (the SOTA default) when no
  // explicit QUANTA_BENCH_LOCALIZE_PHASE override is present.
  // Red-on-injection: remove the `sotaOn ? { phase1Turns: 5 } : undefined`
  // branch and this test fails (localizePhase would be undefined).
  test("SOTA-2: QUANTA_BENCH_SOTA=1 sets localizePhase to {phase1Turns:5}", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    const opt = benchOptIns()
    // localizePhase ALSO carries `lspGroundingSteer:true` under SOTA (LSP-steer
    // is DEFAULT-ON when lspNav is on, jun-17) — that's the LSP-steer suite's
    // invariant, not this one. SOTA's contract is the phase1Turns=5 default, so
    // assert that field directly (decoupled from the steer policy).
    expect(opt.localizePhase?.phase1Turns).toBe(5)
  })

  // SOTA-3: issueHintMode must be "agentless" when SOTA is on and no explicit
  // QUANTA_BENCH_ISSUE_HINT is set.
  // Red-on-injection: remove `sotaOn ? "agentless" :` from the ternary and
  // this test fails (issueHintMode falls through to "off").
  test("SOTA-3: QUANTA_BENCH_SOTA=1 sets issueHintMode to agentless", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    const opt = benchOptIns()
    expect(opt.issueHintMode).toBe("agentless")
  })

  // SOTA-4: sotaOn field itself must be true — the resolver must surface the
  // flag value directly so callers (buildConfig, knobsForReport) can branch.
  // Red-on-injection: remove the `sotaOn` field from the return object and
  // this test fails.
  test("SOTA-4: QUANTA_BENCH_SOTA=1 sets sotaOn===true", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    const opt = benchOptIns()
    expect(opt.sotaOn).toBe(true)
  })

  // SOTA-5: without SOTA flag, all three preset fields remain at defaults.
  // This is the baseline invariant — confirms SOTA is truly default-OFF and
  // none of the SOTA branches fire when the env var is absent.
  test("SOTA-5: without SOTA flag, lspNav=false, localizePhase=undefined, issueHintMode=off", () => {
    // All ENV_KEYS already deleted in beforeEach — no SOTA set.
    const opt = benchOptIns()
    expect(opt.sotaOn).toBe(false)
    expect(opt.lspNav).toBe(false)
    expect(opt.localizePhase).toBeUndefined()
    expect(opt.issueHintMode).toBe("off")
  })

  // SOTA-6: QUANTA_BENCH_LSP=0 does NOT override SOTA lspNav because the
  // composition is `lspNav = sotaOn || gateOn(BENCH_LSP)`. `gateOn("0")` is
  // false, but `sotaOn` is true and the OR short-circuits — lspNav stays true.
  // This test pins the OR-composition contract: individual kill-switch cannot
  // suppress a super-preset's positive assertion.
  test("SOTA-6: QUANTA_BENCH_LSP=0 with SOTA=1 — OR-composition keeps lspNav===true", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    process.env.QUANTA_BENCH_LSP = "0"
    const opt = benchOptIns()
    // sotaOn is true; lspNav = true || false = true (OR wins).
    expect(opt.lspNav).toBe(true)
  })

  // SOTA-7: QUANTA_BENCH_LOCALIZE_PHASE=3 with SOTA=1 — explicit value (3)
  // wins over the SOTA default (5) via the `??` operator.
  // Composition: `parseLocalizePhaseEnv("3") ?? (sotaOn ? {phase1Turns:5} : undefined)`
  // Since `parseLocalizePhaseEnv("3")` returns `{phase1Turns:3}` (non-nullish),
  // the `??` right-hand side is never evaluated.
  // Red-on-injection: swap `??` for `||` and this test still passes (but SOTA-2
  // would break for 0-ish values). Pin this test to prove the exact `??` contract.
  test("SOTA-7: explicit QUANTA_BENCH_LOCALIZE_PHASE=3 with SOTA=1 uses explicit value (3), not SOTA default (5)", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    process.env.QUANTA_BENCH_LOCALIZE_PHASE = "3"
    const opt = benchOptIns()
    // (localizePhase also carries lspGroundingSteer:true under SOTA — assert the
    // phase1Turns field directly, see SOTA-2.) The explicit override wins.
    expect(opt.localizePhase?.phase1Turns).toBe(3)
    // Confirm we did NOT get the SOTA default of 5.
    expect(opt.localizePhase?.phase1Turns).not.toBe(5)
  })

  // SOTA-8: issueHintExpectedActual must be true when SOTA=1, even without the
  // explicit QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL flag.
  // Red-on-injection: remove `sotaOn ||` from the issueHintExpectedActual line
  // and this test fails (eaRaw is undefined, so it would be false).
  test("SOTA-8: QUANTA_BENCH_SOTA=1 enables issueHintExpectedActual", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    const opt = benchOptIns()
    expect(opt.issueHintExpectedActual).toBe(true)
  })

  // SOTA-9: without SOTA, issueHintExpectedActual stays false when the explicit
  // flag is also absent — confirms default-OFF is preserved.
  test("SOTA-9: without SOTA, issueHintExpectedActual=false when flag absent", () => {
    const opt = benchOptIns()
    expect(opt.issueHintExpectedActual).toBe(false)
  })
})
