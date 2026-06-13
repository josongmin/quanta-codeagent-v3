/**
 * AUTO-APPROVAL REVIEW OBSERVER — surface-facing notice seam for the agent
 * reviewer (T03, feature `03-guardian-auto-approval-reviewer`).
 *
 * When the operator opts into the agent reviewer (`QUANTA_AUTO_REVIEW` /
 * `QUANTA_APPROVAL_LADDER=guardian-approvals`), a tool call may be auto-approved
 * by the side-agent guardian with NO human prompt. That decision must NOT be
 * invisible — the observability north-star is "the user can see what the agent
 * is doing and why". Codex surfaces this as `item/autoApprovalReview/started →
 * completed`; this seam emits the SAME started/completed pair.
 *
 * Mirrors {@link import("./recorder").setPermissionRecorder}: a slice-local
 * default-OFF module sink (no `@/stream` import — slice isolation). The
 * composition root registers an adapter that projects each event onto the
 * user-facing stream (a `tool_progress` notice keyed by the tool-call id), so
 * both the CLI timeline and the web card show "auto-reviewed by guardian".
 *
 * Default-OFF guarantee: no registered observer ⇒ every emit is a zero-alloc
 * no-op (byte-identical hot path). A throw from the observer is swallowed here —
 * a telemetry/UI bug must NEVER alter a permission decision.
 */

import type { ApprovalOutcome, ReviewerTier } from "./types"

/** One reviewer-lifecycle signal. `started` fires before the (agent) reviewer
 *  renders its verdict; `completed` carries the outcome. Emitted ONLY for the
 *  auto tiers (`guardian_subagent` / `auto_review`) — the `user` tier already
 *  has a visible prompt and is never auto-reviewed. */
export interface AutoApprovalReviewEvent {
  readonly phase: "started" | "completed"
  /** The dispatch tool-call id the notice attaches to (`tool_progress.id`).
   *  `undefined` when the caller could not supply one (best-effort). */
  readonly toolCallId: string | undefined
  readonly tool: string
  readonly reviewer: ReviewerTier
  /** `completed` only — the terminal outcome + whether it cleared the gate. */
  readonly outcome?: ApprovalOutcome
  readonly allowed?: boolean
  readonly sessionId: string
  readonly turnId: string
}

export interface AutoApprovalReviewObserver {
  observe(event: AutoApprovalReviewEvent): void
}

let observer: AutoApprovalReviewObserver | null = null

/** Register the process-level observer (composition root). `null` clears it. */
export const setAutoApprovalReviewObserver = (next: AutoApprovalReviewObserver | null): void => {
  observer = next
}

/** Test hook — restore the default-OFF (no observer) state. */
export const __resetAutoApprovalReviewObserver = (): void => {
  observer = null
}

/** Emit one event through the registered observer. No-op when none is set;
 *  swallows observer throws (a UI/telemetry fault must not abort a decision). */
export const emitAutoApprovalReview = (event: AutoApprovalReviewEvent): void => {
  if (observer === null) return
  try {
    observer.observe(event)
  } catch {
    // Observational sink — never propagate into the reviewer's return path.
  }
}
