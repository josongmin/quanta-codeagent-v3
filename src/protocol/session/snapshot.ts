import type { LlmContinuationObservation, LlmRequestObservation } from "@/shared/llm-route-types"
import type { CapabilityManifest } from "./capabilities"
import type { PostureProjectionView } from "./posture-projection"

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

/** RFC12-4 (UUX-6-12 web parity) — the SUBAGENT that raised a TEAM-BROKER
 *  escalation, mirrored from the confirm action's `teamEscalation` (the same
 *  payload the CLI card reads to render `Subagent '<workerId>' asks to run …`).
 *  Present ONLY when a WORKER subagent's soft-denied tool escalated to the
 *  leader's HITL authority; absent ⇒ the approval was raised by the main agent
 *  ⇒ the web card renders NO actor label (byte-identical). The card names WHO is
 *  asking so the operator answers an informed prompt, not a bare `Allow <tool>?`. */
export interface ApprovalActor {
  /** The asking worker subagent's stable mailbox id (e.g. `reviewer-agent`) —
   *  the actor label's headline. Mirrors `ToolAction.teamEscalation.workerId`. */
  readonly workerId: string
  /** The scope the worker requested (its role/lane on the ask). Mirrors
   *  `ToolAction.teamEscalation.scope`; optional so a bare worker id still names
   *  the actor. */
  readonly scope?: string
}

export interface PendingApprovalView {
  readonly approvalId: string
  readonly reason: string
  readonly requestedAt: string
  /** ADR-0512 P3 — present ONLY on a skill-scope escalation approval. Absent ⇒
   *  normal approval (byte-identical). See {@link ApprovalScopeContext}. */
  readonly scopeContext?: ApprovalScopeContext
  /** RFC12-4 — present ONLY on a TEAM-BROKER (subagent) escalation approval.
   *  Absent ⇒ main-agent approval (byte-identical). See {@link ApprovalActor}. */
  readonly actor?: ApprovalActor
}

/**
 * Ticket 04 (S4) — the token-usage view carried on {@link SessionStateView}. The
 * kernel already accumulates usage into its session state on every mid-turn
 * `usage` event (`bumpSessionState({ lastTokenUsage })`), but `toSessionStateView`
 * historically dropped it, so a snapshot-only wire consumer never saw mid-turn
 * usage. This projects it — a numeric-only view (no strings ⇒ no redaction /
 * strip concern; the S3 per-peer strip does not apply). Gated on
 * `QUANTA_SESSION_FULL_FIDELITY` at the projection site (default-OFF absent).
 */
export interface SessionTokenUsageView {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  readonly costMicroUsd?: number
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
  /** Ticket 04 (S4) — the most recent mid-turn token usage. Present ONLY when
   *  `QUANTA_SESSION_FULL_FIDELITY` is ON (projection-gated); absent ⇒ byte-
   *  identical default-OFF. See {@link SessionTokenUsageView}. */
  readonly lastTokenUsage?: SessionTokenUsageView
  /** RFC-05 E4 — the resolved posture echo (requested patch / effective view
   *  incl `effectiveMode` / admitted locks) at THIS state revision. Present ONLY
   *  when the host wired a posture control (a `session.posture.set` /
   *  `session.permission.set` reconcile reads it from `describe()`); absent ⇒
   *  byte-identical for a host without a posture projection source. */
  readonly posture?: PostureProjectionView
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
