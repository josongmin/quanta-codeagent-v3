import { extractIssueHint } from "@/agent/issue-hint"
import {
  type PreparedAttemptContext,
  resolveLocationFanoutSeeder,
} from "@/runner/batch/eval/driver"
import { verificationTargetFromPlan } from "@/runner/batch/eval/llm-evidence-packet"
import {
  buildRepairFanoutFiles,
  buildRepairFanoutSymbols,
} from "@/runner/batch/eval/location-set-fanout"
import { buildCleanSelectionAuthorityContracts } from "@/runner/batch/eval/public-contract-bundle"
import type { Instance } from "../../types"
import type { Wiring } from "../report"
import { type Phase, runAgentPhase } from "./agent-phase"
import type { RunInstanceDeps } from "./deps"
import { runRepairPhase } from "./repair"
import { runSelectionPhase } from "./selection"

export const runAppMainPhase = async (args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly wiring: Wiring
  readonly prepared: PreparedAttemptContext
}): Promise<Phase> => {
  if (args.prepared.posture.verifySelectN !== undefined && args.instance.swebench !== undefined) {
    const publicContracts = buildCleanSelectionAuthorityContracts({
      declaredExpected: args.prepared.closureSession?.issueDeclaredExpected,
      candidates: args.prepared.closureSession?.bundle.evidence.candidates,
      apiSymbols: args.prepared.closureSession?.bundle.evidence.issueSymbols,
    })
    return runSelectionPhase({
      instance: args.instance,
      deps: args.deps,
      sandbox: args.sandbox,
      signal: args.signal,
      w: args.wiring,
      n: args.prepared.posture.verifySelectN,
      concurrency: args.prepared.posture.verifySelectConcurrency,
      earlyAccept: args.prepared.posture.verifySelectEarlyAccept,
      riskGate: args.prepared.posture.verifySelectRiskGate,
      llmRiskGateMode: args.prepared.posture.verifySelectLlmRiskGate,
      counterfactual: args.prepared.posture.verifySelectCounterfactual,
      selectorMode: args.prepared.posture.selectorMode,
      verifySelectProofRequired: args.prepared.posture.verifySelectProofRequired,
      publicContracts,
      verifySelectRegression: args.prepared.posture.verifySelectRegression,
      regressionMaxTests: args.prepared.posture.regressionMaxTests,
      verifySelectRepro: args.prepared.posture.verifySelectRepro,
      selectionOwnerCandidates:
        args.prepared.closureSession?.bundle.evidence.candidates.map((c) => c.file) ??
        args.prepared.localizeCandidates,
      ownerResolved: args.prepared.ownerResolved,
      baseValidatedRed: args.prepared.verificationPlan?.baseValidatedRed ?? false,
      verificationPlan: args.prepared.verificationPlan,
      existingTestExpectations: args.prepared.existingTestExpectations,
      reproTest: args.prepared.reproTest,
      precomputedHint: args.prepared.precomputedHint,
      reproHint: args.prepared.reproHint,
      closureHint: args.prepared.closureHint,
      reproSources: args.prepared.reproSources,
      postureOverride: args.prepared.posture,
      stateOverride: args.prepared.state,
      chaRepairTargets: args.prepared.chaRepairTargets,
    })
  }
  if (args.prepared.runRepair && args.prepared.effectiveRepair !== undefined) {
    const repairFanoutFiles = buildRepairFanoutFiles({
      localizeCandidates: args.prepared.localizeCandidates,
      stage1Files: args.prepared.closureSession?.input.evidence.stage1Files,
      ownerResolved: args.prepared.ownerResolved,
      witnessOwners: args.prepared.closureSession?.input.evidence.witnessOwners,
    })
    return runRepairPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.effectiveRepair,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.primaryRailStep,
      args.prepared.ownerResolved?.map((o) => o.file) ?? [],
      args.prepared.reproSources,
      args.prepared.ownerNearRegressionSet,
      verificationTargetFromPlan(args.prepared.verificationPlan),
      args.prepared.closureSession?.issueDeclaredExpected,
      args.prepared.posture,
      args.prepared.state,
      args.prepared.chaRepairTargets,
      resolveLocationFanoutSeeder(
        args.prepared.posture.locationFanout,
        repairFanoutFiles,
        args.prepared.effectiveRepair.breadth ?? args.prepared.posture.repairBreadth,
        buildRepairFanoutSymbols({
          issueSymbols: extractIssueHint(args.instance.problemStatement).symbols,
          fanoutFiles: repairFanoutFiles,
          ownerResolved: args.prepared.ownerResolved,
          witnessOwners: args.prepared.closureSession?.input.evidence.witnessOwners,
        }),
      ),
    )
  }
  return runAgentPhase(
    args.instance,
    args.deps,
    args.sandbox,
    args.signal,
    args.wiring,
    args.prepared.precomputedHint,
    args.prepared.reproHint,
    args.prepared.closureHint,
    args.prepared.posture,
    args.prepared.state,
  )
}
