/**
 * Hellgate for the v5 adaptive-escalation PHASE EXECUTOR PORT FACTORY (P6).
 *
 * `makeAdaptiveExecutor(deps)` builds the controller's `executor` port from
 * INJECTED ports (base knob state + env + a `runPhase` runner), so the factory is
 * hermetically testable with fakes — NO real driver/LLM. The executor:
 *   (1) derives the per-phase BenchPosture from the action's modules,
 *   (2) runs the injected phase runner with that posture,
 *   (3) re-projects the FRESH packet through projectRouterEvidence.
 *
 * Teeth:
 *  - POSTURE: the runPhase receives EXACTLY derivePhasePosture(base, modules, env)
 *    (proof-clean ⇒ proof-required + clean selector posture); a paired-control
 *    distinguishes it from the base posture.
 *  - RE-PROJECT (paired-control): the returned RouterEvidence is derived from the
 *    runPhase's FRESH packet, NOT the input packet — flipping one signal in the
 *    runPhase packet flips the returned facts; the input packet does NOT.
 *  - NO-OP FOLD: accept_thin / stop_infra_or_budget (modules=[]) ⇒ posture==base.
 */

import { describe, expect, test } from "bun:test"
import { makeAdaptiveExecutor } from "@/runner/batch/eval/adaptive-escalation/phase-executor"
import { projectRouterEvidence } from "@/runner/batch/eval/adaptive-escalation/router-evidence"
import type { LlmEvidencePacket } from "@/runner/batch/eval/llm-evidence-packet"
import {
  type BenchPosture,
  benchPostureFromState,
  resolveBenchKnobs,
} from "@/runner/batch/eval/knobs-bench"
import {
  type AdaptiveAction,
  derivePhasePosture,
  PHASE_MODULES,
} from "@/runner/batch/eval/posture"

const ENV: NodeJS.ProcessEnv = {}
const baseState = () => resolveBenchKnobs({ envVars: ENV })

/** A blind, fully-evidenced baseline packet (localizationCertain=true). */
const goodPacket = (): LlmEvidencePacket => ({
  stage: "candidate_generation",
  instanceIdHash: "deadbeefdeadbeef",
  evidenceRevision: "rev-1",
  candidatePatchHash: "cafe0000",
  question: "Which deeper phase, if any?",
  allowedActions: ["produce_minimal_patch"],
  forbiddenSources: ["hidden_tests", "gold_patch"],
  publicIssueFacts: ["the parser drops trailing commas"],
  ownerEvidence: [
    {
      file: "pkg/parse.py",
      symbols: ["parse"],
      provenance: "issue-file",
      sourceSlice: "def parse(): ...",
    },
  ],
  proofReceipts: [
    { source: "public_mwe", state: "candidate_green", baseValidatedRed: true },
    { source: "discovered_regression", state: "candidate_green" },
  ],
  contractFacts: [],
  staticFacts: [],
  verificationTarget: {
    primaryRail: { kind: "repro", cmd: "python repro.py", successPredicate: "stdout_contains" },
    required: [],
    optional: [],
    baseValidatedRed: true,
  },
  missingEvidence: [],
})

/** Same packet but with the owner source-slice stripped ⇒ localizationCertain=false. */
const uncertainPacket = (): LlmEvidencePacket => ({
  ...goodPacket(),
  ownerEvidence: [{ file: "a.py", symbols: [], provenance: "x" }],
})

/** A fake runPhase that records the posture it received and returns a fixed packet. */
const recordingRunPhase = (packet: LlmEvidencePacket) => {
  const seen: { action?: AdaptiveAction; posture?: BenchPosture } = {}
  const runPhase = async (args: { action: AdaptiveAction; posture: BenchPosture }) => {
    seen.action = args.action
    seen.posture = args.posture
    return { packet }
  }
  return { runPhase, seen }
}

describe("adaptive phase executor factory (P6)", () => {
  test("POSTURE: runPhase receives exactly derivePhasePosture(base, modules, env)", async () => {
    const action: AdaptiveAction = "run_proof_clean"
    const { runPhase, seen } = recordingRunPhase(goodPacket())
    const executor = makeAdaptiveExecutor({ base: baseState(), env: ENV, runPhase })

    await executor({ action, modules: PHASE_MODULES[action], packet: projectRouterEvidence(goodPacket()) })

    const expected = derivePhasePosture(baseState(), PHASE_MODULES[action], ENV)
    expect(seen.action).toBe(action)
    expect(seen.posture).toEqual(expected)
    // proof-clean meaning, not just deep-equal: proof-required + clean selector.
    expect(seen.posture?.verifySelectProofRequired).toBe(true)
    expect(seen.posture?.selectorMode).toBe("clean")
  })

  test("POSTURE paired-control: the derived posture DIFFERS from the base posture", async () => {
    const action: AdaptiveAction = "run_proof_clean"
    const { runPhase, seen } = recordingRunPhase(goodPacket())
    const executor = makeAdaptiveExecutor({ base: baseState(), env: ENV, runPhase })

    await executor({ action, modules: PHASE_MODULES[action], packet: projectRouterEvidence(goodPacket()) })

    const basePosture = benchPostureFromState(baseState(), ENV)
    // The fold actually changed the posture (else the POSTURE test would be vacuous).
    expect(seen.posture).not.toEqual(basePosture)
    expect(basePosture.verifySelectProofRequired).toBe(false)
  })

  test("RE-PROJECT paired-control: returned facts come from runPhase's FRESH packet, NOT the input", async () => {
    const action: AdaptiveAction = "expand_select"
    // Input packet is fully-evidenced (localizationCertain=true). The runPhase's
    // FRESH packet has the owner slice stripped (localizationCertain=false). If the
    // executor re-projected the FRESH packet, the returned facts flip to false.
    const inputRe = projectRouterEvidence(goodPacket())
    expect(inputRe.facts.localizationCertain).toBe(true)

    const { runPhase } = recordingRunPhase(uncertainPacket())
    const executor = makeAdaptiveExecutor({ base: baseState(), env: ENV, runPhase })

    const out = await executor({ action, modules: PHASE_MODULES[action], packet: inputRe })

    // Fresh-readback: the returned RouterEvidence is the projection of the FRESH packet.
    expect(out.packet.facts.localizationCertain).toBe(false)
    expect(out.packet).toEqual(projectRouterEvidence(uncertainPacket()))
    // And the input packet is untouched/not the source.
    expect(inputRe.facts.localizationCertain).toBe(true)
  })

  test("RE-PROJECT paired-control (inverse): a fresh packet WITH the slice yields localizationCertain=true", async () => {
    const action: AdaptiveAction = "expand_select"
    // Input is UNCERTAIN; the fresh packet is fully-evidenced. Returned must follow
    // the fresh packet (true), proving the executor did not echo the input (false).
    const inputRe = projectRouterEvidence(uncertainPacket())
    expect(inputRe.facts.localizationCertain).toBe(false)

    const { runPhase } = recordingRunPhase(goodPacket())
    const executor = makeAdaptiveExecutor({ base: baseState(), env: ENV, runPhase })

    const out = await executor({ action, modules: PHASE_MODULES[action], packet: inputRe })
    expect(out.packet.facts.localizationCertain).toBe(true)
  })

  test("NO-OP FOLD: accept_thin / stop_infra_or_budget (modules=[]) ⇒ posture == base", async () => {
    const basePosture = benchPostureFromState(baseState(), ENV)
    for (const action of ["accept_thin", "stop_infra_or_budget"] as const) {
      const { runPhase, seen } = recordingRunPhase(goodPacket())
      const executor = makeAdaptiveExecutor({ base: baseState(), env: ENV, runPhase })
      await executor({ action, modules: PHASE_MODULES[action], packet: projectRouterEvidence(goodPacket()) })
      expect(PHASE_MODULES[action]).toEqual([])
      expect(seen.posture).toEqual(basePosture)
    }
  })
})
