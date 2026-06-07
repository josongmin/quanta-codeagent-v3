import type { LlmContinuationObservation, LlmRequestObservation } from "@/shared/llm-route-types"
import type { CapabilityManifest } from "./capabilities"

export interface ArtifactRef {
  readonly artifactId: string
  readonly kind: string
  readonly mimeType: string
  readonly name?: string
  readonly byteLength?: number
  readonly locator: string
  readonly createdAt: string
}

export interface PendingApprovalView {
  readonly approvalId: string
  readonly reason: string
  readonly requestedAt: string
}

export interface SessionStateView {
  readonly status: "idle" | "running" | "awaiting_approval" | "failed" | "closed"
  readonly draftInput: string
  readonly permissionMode: string
  readonly identityMode?: string
  readonly toolProfile?: string
  readonly modelSlug?: string
  readonly messageCount: number
  readonly lastUserText?: string
  readonly lastAssistantText?: string
  readonly streamingAssistantText?: string
  readonly lastOutcomeReason?: string
  readonly lastLlmRequest?: LlmRequestObservation & {
    readonly policy?: import("@/shared/turn-policy-types").TurnPolicySnapshot
  }
  readonly lastLlmContinuation?: LlmContinuationObservation
}

export interface SessionSnapshotLite {
  readonly sessionId: string
  readonly revision: number
  readonly seq: number
  readonly state: SessionStateView
  readonly capabilities: CapabilityManifest
  readonly pendingApproval: PendingApprovalView | null
  readonly openArtifacts: readonly ArtifactRef[]
}
