/**
 * T-PRESET-07 — closed-allowlist ratchet: NO clean preset may enable ANY
 * research-only authority knob.
 *
 * The threat model this fence closes: a future default-on (or copy-paste) change
 * silently adds a research-only authority knob (rca-target-gates / an LLM rubric
 * gate at `on` / repro-doubt / a contaminating regression source) to a CLEAN
 * preset. Clean presets are the leaderboard-reportable, contamination-free
 * profiles; any research-only authority leaking into one would let a heuristic /
 * answer-key / magic-score signal veto or rank a clean-mode candidate — exactly
 * the `research_contaminated` masquerade `score-label.ts` exists to prevent.
 *
 * WHY this is NOT a duplicate of bench-preset-drives-config-hellgate.test.ts:
 *   - PRESET-14b/14e/14f/15d there pin INDIVIDUAL clean presets by NAME with a
 *     HARDCODED literal list, asserting SOME forbidden knobs absent on a
 *     per-preset basis. A NEW clean preset added tomorrow is NOT covered by any
 *     of those name-keyed tests — it would sail through.
 *   - PRESET-SM there iterates a HARDCODED list of clean preset names.
 *   - PRESET-15c there only forbids `rca-target-gates` across ALL presets (clean
 *     and research alike) and only that ONE knob.
 * This ratchet instead DISCOVERS the clean-preset set DYNAMICALLY (resolve every
 * entry in KNOB_PRESETS, keep those whose resolved posture has
 * selectorMode==="clean") and asserts the FULL research-only authority knob set
 * is absent on EVERY one — so a new clean preset is auto-covered and a new
 * research-only knob added to the checker is enforced everywhere at once.
 *
 * Research-only authority signals (SSOT: verification-bundle/authority.ts
 * SIGNAL_AUTHORITY `researchOnly` + score-label.ts `researchKnobTouched`):
 *   declaredExpectedMatch (answer-key matcher), rubricScore (LLM rubric),
 *   discovered-regression "magic score", plus the bench knobs that ARM them:
 *   rca-target-gates, verify-select-llm-risk-gate=on, repro-doubt, and a
 *   contaminating verify-select-regression mode.
 */

import { describe, expect, test } from "bun:test"
import { SIGNAL_AUTHORITY } from "@/agent/verification-bundle/authority"
import { KNOB_PRESETS } from "@/runner/knobs"
import {
  type BenchKnobState,
  type BenchPosture,
  benchPostureFromState,
} from "../../src/runner/batch/eval/knobs-bench"
import { resolveBenchKnobs } from "../../src/apps/bench/eval/driver"

// ── env hygiene: a stale dev shell must not perturb a resolved posture ────────
const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_VERIFY_SELECT_RISK_GATE",
  "QUANTA_BENCH_VERIFY_SELECT_LLM_RISK_GATE",
  "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
  "QUANTA_BENCH_REPRO_DOUBT",
  "QUANTA_BENCH_RCA_TARGET_GATES",
  "QUANTA_LSP_TOOLS",
] as const

/** Resolve a named preset to its (posture, raw knob-state) pair under a CLEAN
 *  env (every QUANTA_BENCH_* scrubbed) so only the preset layer drives the
 *  result. The posture carries the projected authority fields; the raw state is
 *  needed for knobs that fold into AgentConfig (repro-doubt) rather than the
 *  posture, so the checker can inspect BOTH. */
const resolvePreset = (preset: string | undefined): { posture: BenchPosture; state: BenchKnobState } => {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ENV_KEYS) delete env[k]
  if (preset !== undefined) env.QUANTA_BENCH_PRESET = preset
  const state = resolveBenchKnobs({ envVars: env })
  const posture = benchPostureFromState(state, env)
  return { posture, state }
}

/** Resolve to selectorMode, treating an UNRESOLVABLE preset (knob conflict — e.g.
 *  the legacy `everything` preset sets conflicting branch-search<->localize-phase)
 *  as NOT clean: it can't drive a real run, so it can't be a clean profile. Used
 *  only for discovery; the ratchet body re-resolves (and thus re-validates) each
 *  kept preset, so a preset reaching the body is guaranteed resolvable. */
const cleanSelectorOrFalse = (preset: string): boolean => {
  try {
    return resolvePreset(preset).posture.selectorMode === "clean"
  } catch {
    return false
  }
}

// ── the closed research-only authority knob set (the allowlist's complement) ──
//
// A clean preset is admissible iff NONE of these is active. Each entry pairs a
// human-readable reason with a predicate over the resolved (posture, state).
// Adding a new research-only knob = add ONE row here and every clean preset is
// instantly enforced against it.
interface ResearchKnobCheck {
  readonly id: string
  readonly reason: string
  /** TRUE ⇒ this research-only authority is ACTIVE (forbidden in clean). */
  readonly active: (p: BenchPosture, s: BenchKnobState) => boolean
}

/** The contaminating regression sources: a value that grants discovered-regression
 *  "magic score" hard authority WITHOUT an executed witness. `discovered` is
 *  witness-backed (authority.ts: regressionGreen is hardExecutable ONLY because
 *  T-REG-03 enforces executed-witness provenance) so it is ALLOWED in clean;
 *  `gold` is the eval-only hidden PASS_TO_PASS answer-key and is NOT. undefined
 *  (no regression signal) is also fine. So the only safe non-undefined value is
 *  exactly "discovered". */
const isContaminatingRegression = (mode: BenchPosture["verifySelectRegression"]): boolean =>
  mode !== undefined && mode !== "discovered"

const RESEARCH_ONLY_KNOBS: readonly ResearchKnobCheck[] = [
  {
    id: "rca-target-gates",
    reason:
      "targeted-RCA gates — wires the declaredExpected answer-key port (driver.ts: the port is built ONLY when rcaTargetGates) and adds RCA steers; researchOnly authority.",
    active: (p) => p.rcaTargetGates === true,
  },
  {
    id: "verify-select-llm-risk-gate=on",
    reason:
      "LLM semantic risk gate at `on` grants the LLM rubric (rubricScore=researchOnly) live fail-closed expansion authority; only `shadow` (telemetry-only) is clean.",
    active: (p) => p.verifySelectLlmRiskGate === "on",
  },
  {
    id: "repro-doubt",
    reason:
      "repro-doubt steer is a research-contaminating knob (score-label.ts researchKnobTouched lists it explicitly).",
    // repro-doubt folds into AgentConfig (cfg.reproDoubt), NOT the posture, so
    // read the resolved knob value straight off the state.
    active: (_p, s) => s.values.has("repro-doubt"),
  },
  {
    id: "verify-select-regression(magic-score)",
    reason:
      "a non-discovered regression source (e.g. `gold` eval-only PASS_TO_PASS) is a magic-score / answer-key signal with no executed-witness provenance; researchOnly in clean.",
    active: (p) => isContaminatingRegression(p.verifySelectRegression),
  },
] as const

/** The single admissibility checker. Returns the list of VIOLATED research-only
 *  knob ids for a resolved preset (empty ⇒ clean-admissible). Exported shape so
 *  both the live ratchet AND the synthetic-mutation paired-control exercise the
 *  EXACT same logic (no parallel re-implementation that could drift). */
const researchViolations = (posture: BenchPosture, state: BenchKnobState): string[] =>
  RESEARCH_ONLY_KNOBS.filter((k) => k.active(posture, state)).map((k) => k.id)

describe("T-PRESET-07: clean presets carry NO research-only authority knob", () => {
  // ── dynamic discovery: every preset whose RESOLVED posture is selectorMode=clean ──
  const cleanPresets = Object.keys(KNOB_PRESETS).filter(cleanSelectorOrFalse)

  // Guard the guard: if discovery returns 0 the ratchet would be vacuous (it'd
  // pass by iterating nothing). There are known clean presets today, so assert a
  // floor — a refactor that breaks `selector-mode:clean` resolution trips here
  // instead of silently disarming every per-preset assertion below.
  test("auto-discovers a non-empty clean-preset set (anti-vacuous floor)", () => {
    expect(cleanPresets.length).toBeGreaterThanOrEqual(4)
    // And every known-clean preset (these set `selector-mode:clean` literally)
    // is in the discovered set — the discovery isn't dropping any.
    for (const known of [
      "agentless-v3-thin-strict-gated",
      "agentless-v3-thin-strict-counterfactual",
      "agentless-v3-thin-strict-counterfactual-shadow",
      "agentless-v3-thin-strict-closure-select-clean",
      "agentless-v3-thin-strict-closure-select-clean-witness-only",
    ]) {
      expect(cleanPresets).toContain(known)
    }
  })

  // ── the ratchet body: NONE of the research-only knobs active on ANY clean preset ──
  test.each(cleanPresets)("clean preset %s enables no research-only authority knob", (name) => {
    const { posture, state } = resolvePreset(name)
    // Sanity: we only assert this for presets we actually resolved as clean.
    expect(posture.selectorMode).toBe("clean")

    const violations = researchViolations(posture, state)
    // Unconditional assert first, then narrow — so a checker that silently
    // returned [] for everything (vacuous) would still have to face the
    // field-level assertions below.
    expect(violations).toEqual([])

    // Field-level pins (the prompt's explicit list) — narrowing assertions that
    // document EACH forbidden authority independently of the aggregate checker:
    expect(posture.rcaTargetGates).toBe(false) // NOT rca-target-gates
    expect(posture.verifySelectLlmRiskGate).not.toBe("on") // shadow OK, `on` not
    // declaredExpected authority off: the port is gated behind rcaTargetGates
    // (driver.ts:2481 builds it ONLY when rcaTargetGates), so rcaTargetGates===false
    // already proves the answer-key matcher is unwired.
    expect(posture.rcaTargetGates).toBe(false)
    // repro-doubt absent (config-fold knob — assert via raw resolved state).
    expect(state.values.has("repro-doubt")).toBe(false)
    // discovered-regression magic score: the clean presets use the EXECUTED-witness
    // path. Assert the actual SAFE value — either no regression signal, or exactly
    // "discovered" (never a contaminating answer-key source like "gold").
    expect(isContaminatingRegression(posture.verifySelectRegression)).toBe(false)
    if (posture.verifySelectRegression !== undefined) {
      expect(posture.verifySelectRegression).toBe("discovered")
    }
  })

  // ── HELLGATE teeth #1: paired-control — a RESEARCH preset is NOT subject to the
  // allowlist, proving the ratchet body isn't vacuously green (it really filters). ──
  test("paired-control: a research-mode preset is excluded from the clean set (ratchet is live, not vacuous)", () => {
    // agentless-v3-select-regression sets NO selector-mode ⇒ resolves to research.
    const { posture } = resolvePreset("agentless-v3-select-regression")
    expect(posture.selectorMode).toBe("research")
    // It is NOT in the clean-preset set ⇒ the allowlist body above never asserts
    // on it. (If discovery wrongly classed research presets as clean, the body
    // would falsely constrain them — and the floor test's `selectorMode==="clean"`
    // re-assert would catch a misroute.)
    expect(cleanPresets).not.toContain("agentless-v3-select-regression")
    // Concretely: research presets MAY carry authority the clean allowlist forbids.
    // agentless-v3-thin-strict-gated-llm runs the LLM gate at `on` and is research.
    const llm = resolvePreset("agentless-v3-thin-strict-gated-llm")
    expect(llm.posture.selectorMode).toBe("research")
    expect(llm.posture.verifySelectLlmRiskGate).toBe("on")
    expect(cleanPresets).not.toContain("agentless-v3-thin-strict-gated-llm")
  })

  // ── HELLGATE teeth #2: red-on-injection mutation — the checker REJECTS a
  // synthetic clean posture that an injected `rca-target-gates:1` would produce. ──
  // This is the documented mutation: "if you flipped a clean preset to add
  // rca-target-gates:1, the test would go red." We construct the posture that
  // edit WOULD yield and prove the checker (the same `researchViolations` the
  // ratchet body uses) flags it.
  test("red-on-injection: researchViolations rejects each injected research-only authority", () => {
    // Start from a genuinely-clean resolved preset as the base posture/state.
    const base = resolvePreset("agentless-v3-thin-strict-gated")
    expect(researchViolations(base.posture, base.state)).toEqual([]) // baseline clean

    // (a) inject rca-target-gates:1 → posture.rcaTargetGates flips true.
    const rcaInjected: BenchPosture = { ...base.posture, rcaTargetGates: true }
    expect(researchViolations(rcaInjected, base.state)).toContain("rca-target-gates")

    // (b) inject verify-select-llm-risk-gate:on (would be researchOnly authority live).
    const llmInjected: BenchPosture = { ...base.posture, verifySelectLlmRiskGate: "on" }
    expect(researchViolations(llmInjected, base.state)).toContain("verify-select-llm-risk-gate=on")
    // shadow stays CLEAN (telemetry-only) — proves the check distinguishes mode.
    const shadow: BenchPosture = { ...base.posture, verifySelectLlmRiskGate: "shadow" }
    expect(researchViolations(shadow, base.state)).toEqual([])

    // (c) inject a contaminating regression source (gold answer-key).
    const goldInjected: BenchPosture = { ...base.posture, verifySelectRegression: "gold" }
    expect(researchViolations(goldInjected, base.state)).toContain(
      "verify-select-regression(magic-score)",
    )
    // discovered (executed-witness) stays CLEAN.
    const discovered: BenchPosture = { ...base.posture, verifySelectRegression: "discovered" }
    expect(researchViolations(discovered, base.state)).toEqual([])

    // (d) inject repro-doubt:5 into the raw knob state (config-fold knob path).
    const reproState: BenchKnobState = {
      ...base.state,
      values: new Map(base.state.values).set("repro-doubt", {
        value: { stuckRuns: 5 },
        source: "preset",
      }),
    }
    expect(researchViolations(base.posture, reproState)).toContain("repro-doubt")
  })

  // ── Wiring-proof: the research-only knob ids the checker enforces correspond to
  // signals classed `researchOnly` in the authority SSOT — so the checker can't
  // drift from the taxonomy it claims to enforce. ──
  test("checker's authority basis aligns with SIGNAL_AUTHORITY researchOnly classification", () => {
    // The taxonomy SSOT classifies these selector signals as researchOnly; the
    // bench knobs the checker forbids are precisely the ones that ARM them.
    expect(SIGNAL_AUTHORITY.declaredExpectedMatch).toBe("researchOnly")
    expect(SIGNAL_AUTHORITY.rubricScore).toBe("researchOnly")
    // regressionGreen is hardExecutable ONLY under executed-witness provenance —
    // which is why `discovered` (witness-backed) is allowed but `gold` is not.
    expect(SIGNAL_AUTHORITY.regressionGreen).toBe("hardExecutable")
    // The checker enumerates exactly the four research-only authority knobs.
    expect(RESEARCH_ONLY_KNOBS.map((k) => k.id)).toEqual([
      "rca-target-gates",
      "verify-select-llm-risk-gate=on",
      "repro-doubt",
      "verify-select-regression(magic-score)",
    ])
  })
})
