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
import {
  isContaminatingRegressionSource,
  researchContaminationReasons,
} from "@/runner/batch/eval/score-label"
import { KNOB_PRESETS } from "@/runner/knobs"
import { resolveBenchKnobs } from "../../src/apps/bench/eval/driver"
import { type BenchPosture, benchPostureFromState } from "../../src/runner/batch/eval/knobs-bench"

// ── env hygiene: a stale dev shell must not perturb a resolved posture ────────
const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_VERIFY_SELECT_RISK_GATE",
  "QUANTA_BENCH_VERIFY_SELECT_LLM_RISK_GATE",
  "QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED",
  "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
  "QUANTA_BENCH_REPRO_DOUBT",
  "QUANTA_BENCH_RCA_TARGET_GATES",
  "QUANTA_LSP_TOOLS",
] as const

/** Resolve a named preset to its posture under a CLEAN env (every
 *  QUANTA_BENCH_* scrubbed) so only the preset layer drives the result. */
const resolvePreset = (preset: string | undefined): BenchPosture => {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ENV_KEYS) delete env[k]
  if (preset !== undefined) env.QUANTA_BENCH_PRESET = preset
  const state = resolveBenchKnobs({ envVars: env })
  return benchPostureFromState(state, env)
}

/** Resolve to selectorMode, treating an UNRESOLVABLE preset (knob conflict — e.g.
 *  the legacy `everything` preset sets conflicting branch-search<->localize-phase)
 *  as NOT clean: it can't drive a real run, so it can't be a clean profile. Used
 *  only for discovery; the ratchet body re-resolves (and thus re-validates) each
 *  kept preset, so a preset reaching the body is guaranteed resolvable. */
const cleanSelectorOrFalse = (preset: string): boolean => {
  try {
    return resolvePreset(preset).selectorMode === "clean"
  } catch {
    return false
  }
}

/** Thin pass-through to the runtime scorer's SSOT helper, so the clean-preset
 *  allowlist cannot drift from the labeler that marks a solved receipt
 *  contaminated. */
const researchViolations = (posture: BenchPosture): string[] => [
  ...researchContaminationReasons(posture),
]

describe("T-PRESET-07: clean presets carry NO research-only authority knob", () => {
  // ── dynamic discovery: every preset whose RESOLVED posture is selectorMode=clean ──
  const cleanPresets = Object.keys(KNOB_PRESETS).filter(cleanSelectorOrFalse)

  // Guard the guard: if discovery returns 0 the ratchet would be vacuous (it'd
  // pass by iterating nothing). There are known clean presets today, so assert a
  // floor — a refactor that breaks `selector-mode:clean` resolution trips here
  // instead of silently disarming every per-preset assertion below.
  test("auto-discovers a non-empty clean-preset set (anti-vacuous floor)", () => {
    expect(cleanPresets.length).toBeGreaterThanOrEqual(5)
    // And every known-clean preset (these set `selector-mode:clean` literally)
    // is in the discovered set — the discovery isn't dropping any.
    for (const known of [
      "agentless-v3-thin-strict-gated",
      "agentless-v3-thin-strict-counterfactual",
      "agentless-v3-thin-strict-counterfactual-shadow",
      "agentless-v3-thin-strict-closure-select-clean",
      "agentless-v3-thin-strict-closure-select-clean-witness-only",
      "agentless-v4-proof-clean",
    ]) {
      expect(cleanPresets).toContain(known)
    }
  })

  // ── the ratchet body: NONE of the research-only knobs active on ANY clean preset ──
  test.each(cleanPresets)("clean preset %s enables no research-only authority knob", (name) => {
    const posture = resolvePreset(name)
    expect(posture.selectorMode).toBe("clean")

    const violations = researchViolations(posture)
    expect(violations).toEqual([])

    expect(posture.verifySelectLlmRiskGate).not.toBe("on")
    // The answer-key declaredExpected matcher was DELETED (jun-22) — there is no
    // longer any rca-target-gates knob to gate it; it is unwired by absence.
    expect(posture.reproDoubt).toBe(false)
    expect(isContaminatingRegressionSource(posture.verifySelectRegression)).toBe(false)
    if (posture.verifySelectRegression !== undefined) {
      expect(posture.verifySelectRegression).toBe("discovered")
    }
  })

  // ── HELLGATE teeth #1: paired-control — a RESEARCH preset is NOT subject to the
  // allowlist, proving the ratchet body isn't vacuously green (it really filters). ──
  test("paired-control: a research-mode preset is excluded from the clean set (ratchet is live, not vacuous)", () => {
    const posture = resolvePreset("agentless-v3-select-regression")
    expect(posture.selectorMode).toBe("research")
    expect(cleanPresets).not.toContain("agentless-v3-select-regression")

    const llm = resolvePreset("agentless-v3-thin-strict-gated-llm")
    expect(llm.selectorMode).toBe("research")
    expect(llm.verifySelectLlmRiskGate).toBe("on")
    expect(cleanPresets).not.toContain("agentless-v3-thin-strict-gated-llm")
  })

  // ── HELLGATE teeth #2: red-on-injection mutation — the checker REJECTS a
  // synthetic clean posture that an injected research-only knob would produce. ──
  test("red-on-injection: researchViolations rejects each injected research-only authority", () => {
    const base = resolvePreset("agentless-v3-thin-strict-gated")
    expect(researchViolations(base)).toEqual([])

    const llmInjected: BenchPosture = { ...base, verifySelectLlmRiskGate: "on" }
    expect(researchViolations(llmInjected)).toContain("verify-select-llm-risk-gate=on")
    const shadow: BenchPosture = { ...base, verifySelectLlmRiskGate: "shadow" }
    expect(researchViolations(shadow)).toEqual([])

    const goldInjected: BenchPosture = { ...base, verifySelectRegression: "gold" }
    expect(researchViolations(goldInjected)).toContain("verify-select-regression(magic-score)")
    const discovered: BenchPosture = { ...base, verifySelectRegression: "discovered" }
    expect(researchViolations(discovered)).toEqual([])

    const reproInjected: BenchPosture = { ...base, reproDoubt: true }
    expect(researchViolations(reproInjected)).toContain("repro-doubt")
  })

  // ── Wiring-proof: the research-only knob ids the checker enforces correspond to
  // signals classed `researchOnly` in the authority SSOT — so the checker can't
  // drift from the taxonomy it claims to enforce. ──
  test("checker's authority basis aligns with SIGNAL_AUTHORITY researchOnly classification", () => {
    expect(SIGNAL_AUTHORITY.declaredExpectedMatch).toBe("researchOnly")
    expect(SIGNAL_AUTHORITY.rubricScore).toBe("researchOnly")
    // regressionGreen is hardExecutable ONLY under executed-witness provenance —
    // which is why `discovered` (witness-backed) is allowed but `gold` is not.
    expect(SIGNAL_AUTHORITY.regressionGreen).toBe("hardExecutable")
    expect(
      researchContaminationReasons({
        ...resolvePreset("agentless-v3-thin-strict-gated"),
        verifySelectLlmRiskGate: "on",
        reproDoubt: true,
        verifySelectRegression: "gold",
      }),
    ).toEqual([
      "verify-select-llm-risk-gate=on",
      "repro-doubt",
      "verify-select-regression(magic-score)",
    ])
  })
})
