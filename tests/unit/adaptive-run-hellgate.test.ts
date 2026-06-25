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

const intakeWithoutProofContext = (): LlmEvidencePacket => ({
  stage: "candidate_generation",
  instanceIdHash: "deadbeefdeadbeef",
  evidenceRevision: "rev-no-proof",
  candidatePatchHash: "cafe0001",
  question: "Which deeper phase, if any?",
  allowedActions: ["produce_minimal_patch"],
  forbiddenSources: ["hidden_tests"],
  publicIssueFacts: ["the parser drops trailing commas"],
  ownerEvidence: [{ file: "a.py", symbols: ["p"], provenance: "issue-file", sourceSlice: "s" }],
  proofReceipts: [{ source: "public_mwe", state: "not_run" }],
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

  test("RUN-2: run_proof_clean reroutes after one proof-clean phase and keeps the mapped posture", async () => {
    const phase = recordingRunPhase()
    const { modelCall, seen } = scriptedModelCall([
      decision("run_proof_clean"),
      decision("accept_thin"),
    ])
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intake(),
      base: BASE,
      env: ENV,
      modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("finalize")
    expect(phase.postures.length).toBe(1)
    expect(seen.length).toBe(2)
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

  // jun-25 fix: the interpretive "without proof context" / "after base repro"
  // vetoes are DEMOTED to advisory. The model's chosen expensive phase must NOT
  // be force-aborted by a derived proxy — it proceeds (the phase may ESTABLISH
  // the missing context), and the advisory facts are surfaced in the prompt.
  test("RUN-6: repair_with_proof without proof context PROCEEDS (advisory, not aborted)", async () => {
    const phase = recordingRunPhase()
    const { modelCall, seen } = scriptedModelCall([
      decision("repair_with_proof"),
      decision("accept_thin"),
    ])
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intakeWithoutProofContext(),
      base: BASE,
      env: ENV,
      modelCall,
      runPhase: phase.runPhase,
    })
    // RED-ON-INJECTION teeth: reinstate the hard veto in decision-legality
    // (return "repair_with_proof_without_proof_context" when lacksProofContext)
    // and this flips to escalate_needs_human / 0 postures — proving the demotion
    // is what lets the model's expensive choice run.
    expect(result.outcome).toBe("finalize")
    expect(result.reason).not.toContain("illegal_action")
    expect(phase.postures.length).toBe(1)
    // the derived proof-context signal reaches the model as an advisory line.
    expect(seen[0]?.prompt).toContain("Router Advisory Facts")
    expect(seen[0]?.prompt).toContain("lacks proof context")
  })

  test("RUN-7: run_public_repro when base repro already established PROCEEDS (ordering veto demoted)", async () => {
    const phase = recordingRunPhase()
    const { modelCall } = scriptedModelCall([
      decision("run_public_repro"),
      decision("accept_thin"),
    ])
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intake(),
      base: BASE,
      env: ENV,
      modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("finalize")
    expect(result.reason).not.toContain("illegal_action")
    expect(phase.postures.length).toBe(1)
  })

  test("RUN-8: run_proof_clean without proof context PROCEEDS (advisory, not aborted)", async () => {
    const phase = recordingRunPhase()
    const { modelCall, seen } = scriptedModelCall([
      decision("run_proof_clean"),
      decision("accept_thin"),
    ])
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intakeWithoutProofContext(),
      base: BASE,
      env: ENV,
      modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("finalize")
    expect(result.reason).not.toContain("illegal_action")
    expect(phase.postures.length).toBe(1)
    expect(seen[0]?.prompt).toContain("lacks proof context")
  })

  // PAIRED CONTROL #1 (mechanical guards intact): the bounded-loop budget caps
  // still terminate the run with a typed stop — we only removed the interpretive
  // vetoes, not the budget. (RUN-4 already covers per-action; this guards the
  // total-step ceiling under a tight limit.)
  test("RUN-9: budget caps STILL hold after demotion (bounded-loop, typed stop)", async () => {
    const phase = recordingRunPhase()
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intake(),
      base: BASE,
      env: ENV,
      // run_public_repro is expensive+reroute → loops until the expensive cap.
      modelCall: scriptedModelCall([decision("run_public_repro")]).modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("stop")
    expect(result.reason).toBe("max_expensive_exhausted")
    expect(phase.postures.length).toBe(2)
  })

  // PAIRED CONTROL #2 (fail-closed-on-invalid-OUTPUT intact): a malformed model
  // reply STILL escalates and never runs a phase (mechanical, not interpretive).
  test("RUN-10: invalid model OUTPUT still FAILS CLOSED after demotion", async () => {
    const phase = recordingRunPhase()
    const result = await runAdaptiveBenchAttempt({
      intakePacket: intakeWithoutProofContext(),
      base: BASE,
      env: ENV,
      modelCall: scriptedModelCall([{ not: "a decision" }]).modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("escalate_needs_human")
    expect(phase.postures.length).toBe(0)
  })

  // infraBlocked stays HARD — but ONLY when backed by a REAL execution-failure
  // receipt, never the missingEvidence `public_proof` proxy.
  test("RUN-11: run_proof_clean is HARD-vetoed only by a real execution-failure receipt", async () => {
    const phase = recordingRunPhase()
    const infraBlockedPacket = (): LlmEvidencePacket => ({
      ...intakeWithoutProofContext(),
      evidenceRevision: "rev-infra",
      proofReceipts: [{ source: "public_mwe", state: "execution_failed" }],
    })
    const result = await runAdaptiveBenchAttempt({
      intakePacket: infraBlockedPacket(),
      base: BASE,
      env: ENV,
      modelCall: scriptedModelCall([decision("run_proof_clean")]).modelCall,
      runPhase: phase.runPhase,
    })
    expect(result.outcome).toBe("escalate_needs_human")
    expect(result.reason).toContain("illegal_action:run_proof_clean_while_infra_blocked")
    expect(phase.postures.length).toBe(0)
  })

  test("RUN-12: the missingEvidence public_proof PROXY does NOT trigger the hard infra veto", async () => {
    const phase = recordingRunPhase()
    const proxyOnlyPacket = (): LlmEvidencePacket => ({
      ...intakeWithoutProofContext(),
      evidenceRevision: "rev-proxy",
      // proxy infra signal only (no execution_failed/env_prep_failed receipt).
      missingEvidence: [{ kind: "public_proof", reason: "public_proof_infra_blocked" }],
    })
    const { modelCall } = scriptedModelCall([
      decision("run_proof_clean"),
      decision("accept_thin"),
    ])
    const result = await runAdaptiveBenchAttempt({
      intakePacket: proxyOnlyPacket(),
      base: BASE,
      env: ENV,
      modelCall,
      runPhase: phase.runPhase,
    })
    // proxy must NOT abort: the model's expensive choice proceeds.
    expect(result.outcome).toBe("finalize")
    expect(result.reason).not.toContain("illegal_action")
    expect(phase.postures.length).toBe(1)
  })
})
