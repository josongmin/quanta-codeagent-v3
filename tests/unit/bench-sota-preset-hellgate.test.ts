/**
 * Hellgate: QUANTA_BENCH_SOTA=1 super-preset — proves the SOTA++ flag correctly
 * enables lspNav + localizePhase=5 + issueHintMode="agentless" in benchOptIns().
 *
 * MECHANISM (corrected, bugbash #15): there is NO `sotaOn ||` / `sotaOn ? :`
 * composition anymore. `QUANTA_BENCH_SOTA=1` is an ALIAS that resolves to the
 * frozen `agentless-v1` preset (presets.ts:38), which sets the individual knobs
 * `lsp:1`, `localize-phase:5`, `issue-hint:agentless`,
 * `issue-hint-expected-actual:1`. `benchPostureFromState` then derives each
 * posture field from its OWN resolved knob via `readKnobValue` (knobs-bench.ts:
 * 341,350,356,357) — `sotaOn` (line 403/276) is an inert derived LABEL that
 * nothing branches on. So the teeth here are on the PRESET→knob→readKnobValue
 * path, not on any sotaOn branch.
 *
 * Red-on-injection: each test fails if the agentless-v1 preset stops setting its
 * knob, or if benchPostureFromState stops reading that knob. Uses env-isolated
 * beforeEach/afterEach to prevent cross-test bleed (the same pattern as
 * bench-branch-search-wiring-hellgate.test.ts).
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
  // Mechanism: agentless-v1 sets `lsp:1`, and lspNav reads that knob
  // (`readKnobValue(state,"lsp",isTrue)`, knobs-bench.ts:341).
  // Red-on-injection: drop `lsp:"1"` from the agentless-v1 preset, or stop
  // reading the `lsp` knob in benchPostureFromState, and this test fails
  // (QUANTA_BENCH_LSP / QUANTA_LSP_TOOLS are unset, so lspNav would be false).
  test("SOTA-1: QUANTA_BENCH_SOTA=1 enables lspNav", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(true)
  })

  // SOTA-2: localizePhase must be {phase1Turns:5} when no explicit
  // QUANTA_BENCH_LOCALIZE_PHASE override is present.
  // Mechanism: agentless-v1 sets `localize-phase:5`, and localizePhase reads it
  // (`readKnobValue(state,"localize-phase",isLocalizeValue)`, knobs-bench.ts:350).
  // Red-on-injection: drop `"localize-phase":"5"` from the agentless-v1 preset,
  // or stop reading that knob, and this test fails (localizePhase ⇒ undefined).
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
  // Mechanism: agentless-v1 sets `issue-hint:agentless`, and issueHintMode reads
  // it (`readKnobValue(state,"issue-hint",isIssueMode) ?? "off"`, knobs-bench.ts:
  // 356). Red-on-injection: drop `"issue-hint":"agentless"` from the preset, or
  // stop reading the knob, and issueHintMode falls through to "off".
  test("SOTA-3: QUANTA_BENCH_SOTA=1 sets issueHintMode to agentless", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    const opt = benchOptIns()
    expect(opt.issueHintMode).toBe("agentless")
  })

  // SOTA-4: sotaOn label must be true when agentless-v1 is active.
  // NOTE (bugbash #14/#15): sotaOn is an INERT derived label
  // (`state.preset === "agentless-v1"`, knobs-bench.ts:403) — NO production
  // caller branches on it; the behavioral posture comes from the individual
  // knobs (SOTA-1..3). This test only pins that the label still tracks the
  // active preset. It is retained because removing the field is blocked on this
  // group dropping the assertion (see the DEAD FIELD note at knobs-bench.ts:263);
  // until #14 lands the field+assertion stay together.
  // Red-on-injection: remove the `sotaOn` field from the BenchPosture and this
  // test fails to compile / fails the assertion.
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

  // SOTA-6: QUANTA_BENCH_LSP=0 does NOT suppress SOTA lspNav. The real reason is
  // NOT an OR-composition (there is none) — it is the knob RESOLVER layering:
  // the `agentless-v1` preset sets `lsp:1` at the PRESET layer, and the env
  // override `QUANTA_BENCH_LSP=0` parses to falsy/unset (gate parser), so it does
  // NOT flip the preset's `lsp:1`. `readKnobValue(state,"lsp",isTrue)` therefore
  // stays true (knobs-bench.ts:341). This pins that a falsy individual env value
  // cannot suppress a super-preset's positive knob.
  test("SOTA-6: QUANTA_BENCH_LSP=0 with SOTA=1 — preset lsp:1 wins, lspNav===true", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    process.env.QUANTA_BENCH_LSP = "0"
    const opt = benchOptIns()
    // preset lsp:1 survives the falsy "0" env override ⇒ lspNav stays true.
    expect(opt.lspNav).toBe(true)
  })

  // SOTA-7: QUANTA_BENCH_LOCALIZE_PHASE=3 with SOTA=1 — the explicit value (3)
  // wins over the preset default (5). Mechanism: the env value `3` is an ENV-layer
  // override on the `localize-phase` knob, which the resolver layers ON TOP of the
  // preset's `localize-phase:5`, so `readKnobValue(state,"localize-phase",...)`
  // returns {phase1Turns:3} (knobs-bench.ts:350). This pins env-over-preset
  // precedence for a value-taking knob.
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

  test("SOTA-7b: explicit QUANTA_BENCH_LOCALIZE_PHASE=0 with SOTA=1 disables preset localizePhase", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    process.env.QUANTA_BENCH_LOCALIZE_PHASE = "0"
    const opt = benchOptIns()
    expect(opt.localizePhase).toBeUndefined()
  })

  // SOTA-8: issueHintExpectedActual must be true when SOTA=1, even without the
  // explicit QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL flag.
  // Mechanism: agentless-v1 sets `issue-hint-expected-actual:1`, and the field
  // reads it (`readKnobValue(state,"issue-hint-expected-actual",isTrue)`,
  // knobs-bench.ts:357). Red-on-injection: drop that knob from the preset, or
  // stop reading it, and this test fails (the field defaults to false).
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
