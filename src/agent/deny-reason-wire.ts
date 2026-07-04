import type { GuardDecision } from "@/agent/dispatch-guard"
import {
  type DenyPillar,
  hardDenySafeReason,
  type StructuredDenyReason,
  structuredDenyReason,
  type StructuredDenyReasonInput,
} from "@/permission"
import { runtimeConfig } from "@/shared"

export const denyReason = (input: StructuredDenyReasonInput): StructuredDenyReason | undefined =>
  runtimeConfig().surfaceDenyReason ? structuredDenyReason(input) : undefined

const reviewerReasonInput = (safeReason: string): StructuredDenyReasonInput => ({
  layer: "reviewer",
  safeReason,
})

const reviewerApprovalReasonInput = (safeReason: string): StructuredDenyReasonInput => ({
  layer: "reviewer",
  pillar: "approval",
  safeReason,
})

export const reviewerStructuredReason = (safeReason: string): StructuredDenyReason =>
  structuredDenyReason(reviewerReasonInput(safeReason))

export const reviewerApprovalStructuredReason = (safeReason: string): StructuredDenyReason =>
  structuredDenyReason(reviewerApprovalReasonInput(safeReason))

export const reviewerDenyReason = (safeReason: string): StructuredDenyReason | undefined =>
  denyReason(reviewerReasonInput(safeReason))

export const reviewerApprovalDenyReason = (safeReason: string): StructuredDenyReason | undefined =>
  denyReason(reviewerApprovalReasonInput(safeReason))

export const hookDenyReason = (safeReason: string): StructuredDenyReason | undefined =>
  denyReason({ layer: "hook", safeReason })

export const modeApprovalDenyReason = (safeReason: string): StructuredDenyReason | undefined =>
  denyReason({ layer: "mode", pillar: "approval", safeReason })

export const stackDenyReason = (
  safeReason: string,
  pillar?: DenyPillar,
): StructuredDenyReason | undefined =>
  denyReason({
    layer: "stack",
    safeReason,
    ...(pillar !== undefined ? { pillar } : {}),
  })

export const stackApprovalDenyReason = (safeReason: string): StructuredDenyReason | undefined =>
  denyReason({ layer: "stack", pillar: "approval", safeReason })

export const toolProfileDenyReason = (safeReason: string): StructuredDenyReason | undefined =>
  denyReason({ layer: "tool-profile", safeReason })

export const hardDenyStructuredReason = (): StructuredDenyReason | undefined =>
  denyReason({ layer: "hard-deny", safeReason: hardDenySafeReason() })

export const guardStructuredReason = (
  decision: Exclude<GuardDecision, { kind: "allow" }>,
): StructuredDenyReason | undefined =>
  decision.kind === "ask"
    ? stackDenyReason("dispatch guard requested confirmation")
    : stackDenyReason(
        decision.hardDeny
          ? "dispatch guard blocked (security boundary)"
          : "dispatch guard blocked (recoverable posture)",
      )
