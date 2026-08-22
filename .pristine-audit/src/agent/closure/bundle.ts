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
import type { GateDecision, GateSignals } from "@/agent/gate-decision"
import { decideGate } from "@/agent/gate-decision"
import type { OwnerAdmission } from "@/agent/owner-admission"
import { decideOwnerAdmission } from "@/agent/owner-admission"
import type { VerificationPlan, VerificationPlanInput } from "@/agent/verification-plan"
import { buildVerificationPlan } from "@/agent/verification-plan"

export interface ClosureBundle {
  readonly evidence: FaultEvidencePacket
  readonly owner: OwnerAdmission
  readonly plan: VerificationPlan
  readonly gate: GateDecision
}

export interface ClosureBundleInput {
  readonly evidence: FaultEvidenceInput
  /** Owner-admission lead-gap (forwarded to decideOwnerAdmission). Legacy path
   *  only; ignored when `ownerClean`. */
  readonly ownerMinLeadGap?: number
  /** T-OWN-12: when true, owner admission uses the RULE-BASED clean path
   *  (authoritative/advisory lattice, no additive score). Default false keeps
   *  research/legacy localization byte-identical. */
  readonly ownerClean?: boolean
  readonly plan: VerificationPlanInput
  readonly gate: Omit<GateSignals, "commitFast"> & {
    readonly issueProvidesFix: boolean
  }
}

export const assembleClosureBundle = (input: ClosureBundleInput): ClosureBundle => {
  const evidence = buildFaultEvidencePacket(input.evidence)
  const owner = decideOwnerAdmission({
    packet: evidence,
    ...(input.ownerMinLeadGap !== undefined ? { minLeadGap: input.ownerMinLeadGap } : {}),
    ...(input.ownerClean === true ? { clean: true } : {}),
  })
  const plan = buildVerificationPlan(input.plan)
  const gate = decideGate({
    stakes: input.gate.stakes,
    uncertainty: {
      sampleDisagreement:
        input.gate.uncertainty.sampleDisagreement || owner.coverageExpectation !== "single-site",
      unresolvedSymbols: input.gate.uncertainty.unresolvedSymbols,
    },
    signal: input.gate.signal,
    commitFast: {
      issueProvidesFix:
        input.gate.issueProvidesFix && owner.admit && owner.coverageExpectation === "single-site",
      highConfidenceSingleOwner:
        owner.admit && owner.owner !== null && owner.coverageExpectation === "single-site",
    },
  })
  return { evidence, owner, plan, gate }
}
