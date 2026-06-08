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

/** ADR-0512 P3 — the skill-scope ESCALATION context carried on an approval when
 *  (and only when) the approval was raised because the model called a tool
 *  OUTSIDE the active skill's allowlist (not a normal action confirm). Present
 *  ⇒ the surface renders the rich "outside skill scope" approval CARD (tool +
 *  risk + reason + the model's justification); absent ⇒ the surface draws the
 *  plain approve/deny affordance, byte-identical to every pre-ADR-0512 approval.
 *
 *  `risk` is the read-only-vs-mutating distinction the card draws (the same
 *  `ToolRisk` subset the CLI card uses); the daemon derives it from the action's
 *  `isReadOnly` so the card's risk and the dispatch decision can never disagree. */
export interface ApprovalScopeContext {
  /** The out-of-scope tool the model called (e.g. `edit`) — the card's headline
   *  "도구" field. */
  readonly tool: string
  readonly activeSkill: string
  readonly reason: string
  /** The model's one-line rationale for reaching outside scope (Codex
   *  `on-request` justification). Optional — absent ⇒ the card omits the row. */
  readonly justification?: string
  readonly risk: "read-only" | "mutating"
}

export interface PendingApprovalView {
  readonly approvalId: string
  readonly reason: string
  readonly requestedAt: string
  /** ADR-0512 P3 — present ONLY on a skill-scope escalation approval. Absent ⇒
   *  normal approval (byte-identical). See {@link ApprovalScopeContext}. */
  readonly scopeContext?: ApprovalScopeContext
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
