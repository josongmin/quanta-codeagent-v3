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
    return runSelectionPhase(
      args.instance,
      args.deps,
      args.sandbox,
      args.signal,
      args.wiring,
      args.prepared.posture.verifySelectN,
      args.prepared.posture.verifySelectConcurrency,
      args.prepared.posture.verifySelectEarlyAccept,
      args.prepared.posture.verifySelectRiskGate,
      args.prepared.posture.verifySelectLlmRiskGate,
      args.prepared.posture.verifySelectCounterfactual,
      args.prepared.posture.selectorMode,
      args.prepared.posture.verifySelectProofRequired,
      publicContracts,
      args.prepared.posture.verifySelectRegression,
      args.prepared.posture.regressionMaxTests,
      args.prepared.posture.verifySelectRepro,
      args.prepared.closureSession?.bundle.evidence.candidates.map((c) => c.file) ??
        args.prepared.localizeCandidates,
      args.prepared.ownerResolved,
      args.prepared.verificationPlan?.baseValidatedRed ?? false,
      args.prepared.verificationPlan,
      args.prepared.existingTestExpectations,
      args.prepared.reproTest,
      args.prepared.precomputedHint,
      args.prepared.reproHint,
      args.prepared.closureHint,
      args.prepared.reproSources,
      args.prepared.posture,
      args.prepared.state,
      args.prepared.chaRepairTargets,
    )
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
