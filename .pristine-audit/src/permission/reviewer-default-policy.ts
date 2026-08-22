/**
 * Default-reviewer SELECTION policy (T03 / ADR-0029 family).
 *
 * Pure decision logic: given the per-thread permission authority, the live
 * permission mode, the sandbox posture, and which reviewer capabilities are
 * wired, pick the `ReviewerTier` that renders approvals for a turn. This is a
 * peer of `approval-ladder.ts` (which orders the rungs) and `reviewer.ts`
 * (which dispatches to the chosen tier) — all three are the permission slice's
 * own decision surface.
 *
 * It previously lived in `apps/cli/repl/reviewer-policy.ts`, where it was a
 * domain decision leaking into a surface (the audit flagged it: both the input
 * authority record and the output tier are `@/permission` types). The surface
 * now only PARSES the `QUANTA_SANDBOX` env literal into a `ReviewerSandboxProfile`
 * and calls this.
 *
 * Slice rules: imports only sibling permission types — no IO, no env, no LLM.
 */

import type { ThreadPermission } from "./permission-store"
import type { PermissionMode, ReviewerTier } from "./types"

/** OS-level sandbox posture selected on the surface. `default`/`off` mean "no
 *  explicit sandbox posture chosen"; the selection policy only distinguishes
 *  the workspace-write postures (where an agent reviewer is warranted). The
 *  surface maps unknown env literals to `default` so policy never keys on an
 *  invalid value. */
export type ReviewerSandboxProfile =
  | "default"
  | "off"
  | "read-only"
  | "workspace-write"
  | "workspace-write-net"
  | "danger-full-access"

const isWorkspaceWriteProfile = (profile: ReviewerSandboxProfile): boolean =>
  profile === "workspace-write" || profile === "workspace-write-net"

type ReviewerAuthority = Pick<ThreadPermission, "approvalPolicy" | "approvalsReviewer">

const selectExplicitAuthorityReviewer = (
  authority: ReviewerAuthority,
  input: {
    sandboxProfile: ReviewerSandboxProfile
    hasAutoReview: boolean
    hasGuardianReview: boolean
  },
): ReviewerTier => {
  if (authority.approvalsReviewer === "user") return "user"
  if (
    authority.approvalPolicy === "on-request" &&
    input.hasGuardianReview &&
    isWorkspaceWriteProfile(input.sandboxProfile)
  ) {
    return "guardian_subagent"
  }
  if (input.hasAutoReview) return "auto_review"
  return "user"
}

/** Select the default reviewer tier for a turn.
 *
 * Precedence:
 *   1. explicit per-thread permission authority (`approvalPolicy` +
 *      `approvalsReviewer`) when present;
 *   2. T03 explicit agent-reviewer opt-in (`autoReviewEnabled`);
 *   3. legacy CLI fallback (`PermissionMode.default` as the old proxy for
 *      "on-request");
 *   4. final fail-closed `user`.
 *
 * The explicit authority path closes the prior drift: the surface honors the
 * same per-thread permission record the permission stack already uses. The
 * `PermissionMode` fallback remains only for threads with no stored permission
 * record yet, preserving current interactive behavior.
 */
export const selectDefaultReviewer = (input: {
  threadPermission: ReviewerAuthority | undefined
  permissionMode: PermissionMode
  sandboxProfile: ReviewerSandboxProfile
  hasAutoReview: boolean
  hasGuardianReview: boolean
  /** T03 (feature 03-guardian) — the operator opted into the agent reviewer via
   *  the approval ladder (`QUANTA_APPROVAL_LADDER=guardian-approvals`) or its
   *  strict shortcut (`QUANTA_AUTO_REVIEW=1`). When set, the side-agent guardian
   *  renders approvals REGARDLESS of the env sandbox posture — the opt-in IS the
   *  operator's posture choice. Default (absent / false) ⇒ the legacy
   *  posture-gated selection below is byte-identical. An explicit per-thread
   *  authority still takes precedence (handled above). */
  autoReviewEnabled?: boolean
}): ReviewerTier => {
  if (input.threadPermission !== undefined) {
    return selectExplicitAuthorityReviewer(input.threadPermission, input)
  }
  // T03 — explicit agent-reviewer opt-in. Routes to the guardian when its
  // capability is live; falls back to auto_review then user when it is not (so a
  // headless run with no subagent never silently auto-approves with no reviewer).
  if (input.autoReviewEnabled === true && input.hasGuardianReview) {
    return "guardian_subagent"
  }
  if (input.hasAutoReview) return "auto_review"
  if (
    input.hasGuardianReview &&
    input.permissionMode === "default" &&
    isWorkspaceWriteProfile(input.sandboxProfile)
  ) {
    return "guardian_subagent"
  }
  return "user"
}
