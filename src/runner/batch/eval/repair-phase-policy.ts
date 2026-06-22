import type { PrimaryRailStep } from "@/agent/closure"
import type { GateDecision } from "@/agent/gate-decision"
import { decideRepairAdmission } from "@/agent/primary-rail"
import type { VerificationPlan } from "@/agent/verification-plan"
import type { BenchInLoopExecMode } from "./knobs-bench"

export const benchInstallsReproHint = (mode: BenchInLoopExecMode): boolean => mode !== "off"

export const benchRunsRepairPhase = (
  hasRepair: boolean,
  isSwebench: boolean,
  mode: BenchInLoopExecMode,
): boolean => hasRepair && isSwebench && mode === "full"

export const benchShouldRunRepairPhase = (args: {
  eligible: boolean
  primaryRailEnabled: boolean
  gateAction: GateDecision["action"] | undefined
  primaryRailStep: PrimaryRailStep | undefined
  verificationPlan: VerificationPlan | undefined
}): boolean => {
  if (!args.eligible) return false
  if (!args.primaryRailEnabled) return true
  // This is the ADMISSION gate (runs BEFORE the rail is re-run), so a 'green'
  // outcome is not observable here — only "have a validated-red repro" (red) vs
  // "don't" (unrun) are knowable from the static baseValidatedRed fact. The
  // "rail already green ⇒ no repair" branch of decideRepairAdmission is therefore
  // unreachable from THIS caller by design; the post-run green case is owned by
  // decidePrimaryRailFinishGate / primaryRailRedAfterRepair, not here.
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
): boolean => primaryRailStep !== undefined && (validated === false || primaryFalseGreen === true)
