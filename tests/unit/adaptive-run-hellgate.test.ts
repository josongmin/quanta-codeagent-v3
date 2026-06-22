/**
 * Hellgate for the v5 ASSEMBLED adaptive runner (Wave-3 keystone). Proves the
 * full assembly — intake projection → LLM router → bounded controller → phase
 * executor (derivePhasePosture) → re-projection — composes correctly with FAKE
 * ports (no LLM, no driver): fail-closed never executes, the chosen action's
 * posture actually reaches runPhase, bounded loop terminates, reroute re-projects.
 */

import { describe, expect, test } from "bun:test"
import { runAdaptiveBenchAttempt } from "@/runner/batch/eval/adaptive-escalation/adaptive-run"
import type { AdaptiveModelCallArgs } from "@/runner/batch/eval/adaptive-escalation/llm-router"
import type { RunPhasePort } from "@/runner/batch/eval/adaptive-escalation/phase-executor"
import type { BenchPosture } from "@/runner/batch/eval/knobs-bench"
import { resolveBenchKnobs } from "@/runner/batch/eval/knobs-bench"
import type { LlmEvidencePacket } from "@/runner/batch/eval/llm-evidence-packet"

const BASE = resolveBenchKnobs({
  envVars: { QUANTA_BENCH_PRESET: "agentless-v3-thin-strict" } as NodeJS.ProcessEnv,
})
const ENV = {} as NodeJS.ProcessEnv

const intake = (rev = "rev-1"): LlmEvidencePacket => ({
  stage: "candidate_generation",
  instanceIdHash: "deadbeefdeadbeef",
  evidenceRevision: rev,
  candidatePatchHash: "cafe0000",
  question: "Which deeper phase, if any?",
  allowedActions: ["produce_minimal_patch"],
  forbiddenSources: ["hidden_tests"],
  publicIssueFacts: ["the parser drops trailing commas"],
  ownerEvidence: [{ file: "a.py", symbols: ["p"], provenance: "issue-file", sourceSlice: "s" }],
  proofReceipts: [{ source: "public_mwe", state: "candidate_red", baseValidatedRed: true }],
  contractFacts: [],
  staticFacts: [],
  missingEvidence: [],
})

const decision = (action: string, citedEvidenceIds: string[] = []) => ({
  action,
  evidenceGaps: [],
  citedEvidenceIds,
  why: "x",
})

/** Scripted LLM seam: returns one raw decision per call. */
const scriptedModelCall = (script: readonly unknown[]) => {
  let i = 0
  const seen: AdaptiveModelCallArgs[] = []
  const modelCall = (args: AdaptiveModelCallArgs): Promise<unknown> => {
    seen.push(args)
    return Promise.resolve(script[Math.min(i++, script.length - 1)])
  }
  return { modelCall, seen }
}

/** Recording phase seam: records the posture each phase ran under, returns a fresh packet. */
const recordingRunPhase = (freshRev: (n: number) => string = () => "rev-fresh") => {
  const postures: BenchPosture[] = []
  const runPhase: RunPhasePort = ({ posture }) => {
    postures.push(posture)
    return Promise.resolve({ packet: intake(freshRev(postures.length)) })
  }
  return { runPhase, postures }
}

describe("assembled adaptive runner (Wave-3 keystone)", () => {
  test("RUN-1: accept_thin finalizes WITHOUT running a phase", async () => {
    const phase = recordingRunPhase()
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intake(),
      base: BASE,
      env: ENV,
      modelCall: scriptedModelCall([decision("accept_thin")]).modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("finalize")
    expect(phase.postures.length).toBe(0)
  })

  test("RUN-2: run_proof_clean reaches runPhase with the PROOF-CLEAN posture (action→modules→posture)", async () => {
    const phase = recordingRunPhase()
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intake(),
      base: BASE,
      env: ENV,
      modelCall: scriptedModelCall([decision("run_proof_clean")]).modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("finalize")
    expect(phase.postures.length).toBe(1)
    // The assembly mapped run_proof_clean → PHASE_MODULES → derivePhasePosture:
    // the proof-clean posture must carry proof-required + clean selector + repro-only exec.
    expect(phase.postures[0]?.verifySelectProofRequired).toBe(true)
    expect(phase.postures[0]?.selectorMode).toBe("clean")
    expect(phase.postures[0]?.inLoopExecMode).toBe("repro-only")
  })

  test("RUN-3: invalid model output FAILS CLOSED (escalate, no phase run, no submit)", async () => {
    const phase = recordingRunPhase()
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intake(),
      base: BASE,
      env: ENV,
      modelCall: scriptedModelCall([decision("run_everything")]).modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("escalate_needs_human")
    expect(result.reason).toContain("unknown_action")
    expect(phase.postures.length).toBe(0)
  })

  test("RUN-4: a re-route loop is bounded (typed stop, phase ran capped times)", async () => {
    const phase = recordingRunPhase()
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intake(),
      base: BASE,
      env: ENV,
      modelCall: scriptedModelCall([decision("deeper_localize")]).modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("stop")
    expect(result.reason).toBe("max_per_action_exhausted")
    expect(phase.postures.length).toBeGreaterThan(0)
    // deeper_localize is a no-op posture (≡ thin base) — verifies modules=[] folds to base.
    expect(phase.postures[0]?.verifySelectProofRequired).toBe(false)
  })

  test("RUN-5: reroute feeds the FRESH re-projected packet to the next route", async () => {
    const phase = recordingRunPhase(() => "rev-after-phase")
    const { modelCall, seen } = scriptedModelCall([
      decision("deeper_localize"),
      decision("accept_thin"),
    ])
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intake("rev-initial"),
      base: BASE,
      env: ENV,
      modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("finalize")
    expect(phase.postures.length).toBe(1)
    // 2 router calls: the first prompt carries the initial packet body, the second
    // carries the post-phase re-projected packet — proves the loop re-projects.
    expect(seen.length).toBe(2)
    expect(seen[0]?.prompt).toContain("rev-initial")
    expect(seen[1]?.prompt).toContain("rev-after-phase")
  })
})
