/**
 * Closure engine — build a typed {@link PrimaryRailStep} from a VerificationPlan
 * step (T-2). PURE. Shared by both bench drivers so the defensive defaults live
 * in ONE place (a required step always carries authority + successPredicate, but
 * the type marks them optional for back-compat optional steps — so we default to
 * the execution proof when absent).
 */

import type { VerificationStep } from "@/agent/verification-plan"
import type { PrimaryRailStep } from "./types"

export const buildPrimaryRailStep = (
  step: VerificationStep | null | undefined,
): PrimaryRailStep | undefined => {
  if (step === null || step === undefined || step.cmd === "") return undefined
  return {
    cmd: step.cmd,
    authority: step.authority ?? "execution",
    successPredicate: step.successPredicate ?? { type: "test_exit_zero" },
  }
}
