import type { PrimaryRailStep } from "@/agent/closure"
import type { GateDecision } from "@/agent/gate-decision"
import { decideRepairAdmission } from "@/agent/primary-rail"
import type { VerificationPlan } from "@/agent/verification-plan"

export const benchInstallsReproHint = (inLoopExec: boolean): boolean => inLoopExec

export const benchRunsRepairPhase = (
  hasRepair: boolean,
  isSwebench: boolean,
  inLoopExec: boolean,
): boolean => hasRepair && isSwebench && inLoopExec

export const benchShouldRunRepairPhase = (args: {
  eligible: boolean
  primaryRailEnabled: boolean
  gateAction: GateDecision["action"] | undefined
  primaryRailStep: PrimaryRailStep | undefined
  verificationPlan: VerificationPlan | undefined
}): boolean => {
  if (!args.eligible) return false
  if (!args.primaryRailEnabled) return true
  const repairAdmission = decideRepairAdmission({
    primaryRailPresent: args.primaryRailStep !== undefined,
    primaryRailState:
      args.primaryRailStep !== undefined && args.verificationPlan?.baseValidatedRed === true
        ? "red"
        : "unrun",
  })
  return repairAdmission.admit && args.gateAction === "verify"
}

export const primaryRailRedAfterRepair = (
  primaryRailStep: PrimaryRailStep | undefined,
  validated: boolean | undefined,
  primaryFalseGreen: boolean | undefined,
): boolean =>
  primaryRailStep !== undefined && (validated === false || primaryFalseGreen === true)
