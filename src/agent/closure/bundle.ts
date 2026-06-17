/**
 * Closure engine — ClosureBundle SSOT (jun-17 T-3). PURE.
 *
 * The ONE artifact that prompt / gate / repair / diagnostics all consume, so the
 * closure facts are computed ONCE and never drift between consumers. Assembles
 * the four existing core deciders into a single internally-consistent snapshot:
 *
 *   evidence (what to look at)  → owner (single-site vs owner-family)
 *   plan (what proof is required) → gate (commit-fast vs verify-first)
 *
 * Crucially `owner` is derived FROM the same `evidence` packet, so the bundle is
 * self-consistent (no consumer can pair an owner with a different evidence view).
 * Adapters (bench/chat) build the inputs; this stays pure.
 */

import { buildFaultEvidencePacket } from "@/agent/fault-evidence/build"
import type { FaultEvidenceInput, FaultEvidencePacket } from "@/agent/fault-evidence/types"
import { decideGate } from "@/agent/gate-decision"
import type { GateDecision, GateSignals } from "@/agent/gate-decision"
import { decideOwnerAdmission } from "@/agent/owner-admission"
import type { OwnerAdmission } from "@/agent/owner-admission"
import { buildVerificationPlan } from "@/agent/verification-plan"
import type { VerificationPlan, VerificationPlanInput } from "@/agent/verification-plan"

export interface ClosureBundle {
  readonly evidence: FaultEvidencePacket
  readonly owner: OwnerAdmission
  readonly plan: VerificationPlan
  readonly gate: GateDecision
}

export interface ClosureBundleInput {
  readonly evidence: FaultEvidenceInput
  /** Owner-admission lead-gap (forwarded to decideOwnerAdmission). */
  readonly ownerMinLeadGap?: number
  readonly plan: VerificationPlanInput
  readonly gate: GateSignals
}

export const assembleClosureBundle = (input: ClosureBundleInput): ClosureBundle => {
  const evidence = buildFaultEvidencePacket(input.evidence)
  const owner = decideOwnerAdmission({
    packet: evidence,
    ...(input.ownerMinLeadGap !== undefined ? { minLeadGap: input.ownerMinLeadGap } : {}),
  })
  const plan = buildVerificationPlan(input.plan)
  const gate = decideGate(input.gate)
  return { evidence, owner, plan, gate }
}
