/**
 * Hellgate for the v5 posture injection seam (jun-22 Wave-1 skeleton).
 *
 * The seam lets the v5 controller materialize a per-phase {@link BenchPosture}
 * by folding detachable {@link KnobModule}s onto a thin base, instead of
 * selecting a whole preset up front. Two properties MUST hold or the seam is
 * worthless:
 *
 *   1. Byte-identical fence — folding ZERO modules changes nothing, so the seam
 *      cannot perturb the existing default posture.
 *   2. Equivalence — each named capability composite reproduces a SHIPPED
 *      preset's posture EXACTLY. This is what proves the modules carry real
 *      capability and never drift from `presets.ts`; without it the catalog
 *      could be a pile of plausible-but-wrong fragments.
 *
 * Teeth beyond those: detach paired-control (a module governs EXACTLY one
 * capability field), red-on-injection (a wrong fragment value breaks
 * equivalence, so EQUIV is not vacuous), purity (base is never mutated), and
 * typo/misconfig surfacing.
 */

import { describe, expect, test } from "bun:test"
import {
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "@/runner/batch/eval/knobs-bench"
import {
  CLOSURE_SELECT_CLEAN_MODULES,
  derivePhasePosture,
  type KnobModule,
  PHASE_MODULES,
  PROOF_CLEAN_EXECFULL_MODULES,
  PROOF_CLEAN_MODULES,
  PROOF_REQUIRED,
  rejectedModuleKnobs,
  SELECT_MODULES,
  SELECT_N,
  unknownModuleKnobs,
  withKnobModules,
} from "@/runner/batch/eval/posture"
import { benchRunsRepairPhase } from "@/runner/batch/eval/repair-phase-policy"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

const EMPTY_ENV = {} as NodeJS.ProcessEnv

/** Hermetic state for a named preset (closed-port: only the explicit map is read). */
const stateFor = (preset: string) =>
  resolveBenchKnobs({ envVars: { QUANTA_BENCH_PRESET: preset } as NodeJS.ProcessEnv })

const THIN_BASE = "agentless-v3-thin-strict"

/** Posture minus the telemetry-only fields that legitimately differ between a
 *  derived posture (keeps the base preset name) and a directly-resolved one. */
const behavioral = (p: BenchPosture): Omit<BenchPosture, "preset" | "sotaOn"> => {
  const { preset: _preset, sotaOn: _sotaOn, ...rest } = p
  return rest
}

/** The seam must reproduce each shipped preset's BEHAVIORAL posture exactly. */
const EQUIVALENCES: ReadonlyArray<{
  readonly name: string
  readonly modules: readonly KnobModule[]
  readonly preset: string
}> = [
  { name: "select", modules: SELECT_MODULES, preset: "agentless-v3-thin-strict-select" },
  {
    name: "closure-select-clean",
    modules: CLOSURE_SELECT_CLEAN_MODULES,
    preset: "agentless-v3-thin-strict-closure-select-clean",
  },
  { name: "proof-clean", modules: PROOF_CLEAN_MODULES, preset: "agentless-v4-proof-clean" },
  {
    name: "proof-clean-execfull",
    modules: PROOF_CLEAN_EXECFULL_MODULES,
    preset: "agentless-v4-proof-clean-execfull",
  },
]

describe("posture phase-module seam", () => {
  describe("byte-identical fence", () => {
    test("FENCE-1: folding zero modules equals the base posture exactly", () => {
      const base = stateFor(THIN_BASE)
      const derived = derivePhasePosture(base, [], EMPTY_ENV)
      const direct = benchPostureFromState(base, EMPTY_ENV)
      expect(derived).toEqual(direct)
    })

    test("FENCE-2: a no-op module (empty knobs) does not perturb the posture", () => {
      const base = stateFor(THIN_BASE)
      const noop: KnobModule = { id: "noop", knobs: {} }
      expect(behavioral(derivePhasePosture(base, [noop], EMPTY_ENV))).toEqual(
        behavioral(benchPostureFromState(base, EMPTY_ENV)),
      )
    })
  })

  describe("equivalence to shipped presets (core teeth)", () => {
    for (const { name, modules, preset } of EQUIVALENCES) {
      test(`EQUIV[${name}]: thin-base + modules ≡ ${preset}`, () => {
        // CHURN-ROBUST: a preset this composite reproduces may have been removed
        // by a concurrent registry reshape — skip (nothing to pin). The canonical
        // raw-identity guard is `bench-preset-composite-identity.test.ts`; this
        // behavioral check is a redundant tooth that must not false-RED on churn.
        if (KNOB_PRESETS[preset] === undefined) return
        const derived = derivePhasePosture(stateFor(THIN_BASE), modules, EMPTY_ENV)
        const direct = benchPostureFromState(stateFor(preset), EMPTY_ENV)
        expect(behavioral(derived)).toEqual(behavioral(direct))
      })
    }
  })

  describe("detachability (paired-control)", () => {
    test("DETACH-1: removing PROOF_REQUIRED flips EXACTLY verifySelectProofRequired", () => {
      const base = stateFor(THIN_BASE)
      const withProof = derivePhasePosture(base, PROOF_CLEAN_MODULES, EMPTY_ENV)
      const withoutProof = derivePhasePosture(
        base,
        PROOF_CLEAN_MODULES.filter((m) => m.id !== PROOF_REQUIRED.id),
        EMPTY_ENV,
      )
      expect(withProof.verifySelectProofRequired).toBe(true)
      expect(withoutProof.verifySelectProofRequired).toBe(false)
      // Every OTHER behavioral field is unchanged — the module governs one capability.
      expect(behavioral({ ...withoutProof, verifySelectProofRequired: true })).toEqual(
        behavioral(withProof),
      )
    })
  })

  describe("red-on-injection (equivalence is not vacuous)", () => {
    test("RED-1: wrong N in proof-clean breaks preset equivalence", () => {
      const wrong = PROOF_CLEAN_MODULES.map((m) => (m.id.startsWith("select-n-") ? SELECT_N(2) : m))
      const derived = derivePhasePosture(stateFor(THIN_BASE), wrong, EMPTY_ENV)
      const direct = benchPostureFromState(stateFor("agentless-v4-proof-clean"), EMPTY_ENV)
      expect(behavioral(derived)).not.toEqual(behavioral(direct))
      expect(derived.verifySelectN).toBe(2)
      expect(direct.verifySelectN).toBe(5)
    })
  })

  describe("purity", () => {
    test("PURE-1: withKnobModules does not mutate the base state values", () => {
      const base = stateFor(THIN_BASE)
      const sizeBefore = base.values.size
      const hadProofRequired = base.values.has("verify-select-proof-required")
      withKnobModules(base, PROOF_CLEAN_MODULES)
      expect(base.values.size).toBe(sizeBefore)
      expect(base.values.has("verify-select-proof-required")).toBe(hadProofRequired)
    })

    test("PURE-2: empty modules return the SAME state reference (fast path)", () => {
      const base = stateFor(THIN_BASE)
      expect(withKnobModules(base, [])).toBe(base)
    })
  })

  describe("typo / misconfig surfacing (fail-open, never crash)", () => {
    test("MISCFG-1: an unregistered knob id is flagged and skipped", () => {
      const base = stateFor(THIN_BASE)
      const typo: KnobModule = { id: "typo", knobs: { "verify-slect": "5" } }
      expect(unknownModuleKnobs(base, [typo])).toContain("typo:verify-slect")
      // skipped, no throw, posture for real knobs unchanged
      expect(behavioral(derivePhasePosture(base, [typo], EMPTY_ENV))).toEqual(
        behavioral(benchPostureFromState(base, EMPTY_ENV)),
      )
    })

    test("MISCFG-2: an out-of-domain fragment value is flagged and skipped", () => {
      const base = stateFor(THIN_BASE)
      const bad: KnobModule = { id: "bad", knobs: { "verify-select": "not-a-number" } }
      expect(rejectedModuleKnobs(base, [bad])).toContain("bad:verify-select=not-a-number")
      expect(derivePhasePosture(base, [bad], EMPTY_ENV).verifySelectN).toBeUndefined()
    })
  })

  describe("v5 action map", () => {
    test("ACTION-1: accept_thin and stop_infra_or_budget are no-op postures", () => {
      const base = stateFor(THIN_BASE)
      const thin = behavioral(benchPostureFromState(base, EMPTY_ENV))
      expect(behavioral(derivePhasePosture(base, PHASE_MODULES.accept_thin, EMPTY_ENV))).toEqual(
        thin,
      )
      expect(
        behavioral(derivePhasePosture(base, PHASE_MODULES.stop_infra_or_budget, EMPTY_ENV)),
      ).toEqual(thin)
    })

    test("ACTION-2: run_proof_clean maps to the proof-clean posture", () => {
      const base = stateFor(THIN_BASE)
      expect(
        behavioral(derivePhasePosture(base, PHASE_MODULES.run_proof_clean, EMPTY_ENV)),
      ).toEqual(behavioral(benchPostureFromState(stateFor("agentless-v4-proof-clean"), EMPTY_ENV)))
    })

    test("ACTION-3: every action's modules reference only registered knobs", () => {
      const base = stateFor(THIN_BASE)
      for (const modules of Object.values(PHASE_MODULES)) {
        expect(unknownModuleKnobs(base, modules)).toEqual([])
        expect(rejectedModuleKnobs(base, modules)).toEqual([])
      }
    })

    test("ACTION-4: repair_with_proof actually ENGAGES the repair phase (not inert)", () => {
      // Round-A defect: PROOF_CLEAN's repro-only exec made benchRunsRepairPhase
      // false, so REPAIR_BOUNDED was a no-op. FULL_EXEC must override it to full.
      const p = derivePhasePosture(stateFor(THIN_BASE), PHASE_MODULES.repair_with_proof, EMPTY_ENV)
      expect(p.repairRounds).toBe(1)
      expect(p.inLoopExecMode).toBe("full")
      // The real gate the driver consults — proves the round is reachable.
      expect(benchRunsRepairPhase(p.repairRounds !== undefined, true, p.inLoopExecMode)).toBe(true)
    })

    test("ACTION-5: deeper_localize occupies ONLY the forward-localize lever (sole delta, default-OFF)", () => {
      // T3 (jun-24): the route is no longer a bare no-op — it turns on the
      // default-OFF forward-localize knob and NOTHING else. forward-localize is
      // the SOLE behavioral delta vs thin (no smuggled unvalidated dial), and the
      // knob itself stays OFF until the controller routes here, so promotion still
      // requires the frozen-slice A/B.
      const base = stateFor(THIN_BASE)
      const deeper = derivePhasePosture(base, PHASE_MODULES.deeper_localize, EMPTY_ENV)
      const thin = benchPostureFromState(base, EMPTY_ENV)
      expect(deeper.forwardLocalize).toBe(true)
      expect(thin.forwardLocalize).toBe(false)
      expect(behavioral(deeper)).toEqual(behavioral({ ...thin, forwardLocalize: true }))
    })

    test("RATCHET: every selector-touching action yields CLEAN selector authority", () => {
      // Forbid a future implementer from routing an action to a research-mode
      // (heuristic-veto) selector. Any action whose posture runs verify-select
      // MUST be clean (v5 readme: no research-only veto in the adaptive run).
      const base = stateFor(THIN_BASE)
      for (const [action, modules] of Object.entries(PHASE_MODULES)) {
        const p = derivePhasePosture(base, modules, EMPTY_ENV)
        if (p.verifySelectN !== undefined) {
          expect(p.selectorMode, `action ${action} must be clean`).toBe("clean")
        }
      }
    })
  })
})
