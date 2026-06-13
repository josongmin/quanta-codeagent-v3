import type { PermissionMode, ReviewerTier, ThreadPermission } from "@/permission"

/** CLI-owned raw sandbox profiles. `default`/`off` mean "no explicit OS-level
 * sandbox posture selected on the surface"; unknown strings collapse to
 * `default` so reviewer policy never keys on an invalid env literal. */
export type CliReviewerSandboxProfile =
  | "default"
  | "off"
  | "read-only"
  | "workspace-write"
  | "workspace-write-net"
  | "danger-full-access"

export const parseCliReviewerSandboxProfile = (
  raw: string | undefined,
): CliReviewerSandboxProfile => {
  switch (raw) {
    case undefined:
    case "":
      return "default"
    case "default":
    case "off":
    case "read-only":
    case "workspace-write":
    case "workspace-write-net":
    case "danger-full-access":
      return raw
    default:
      return "default"
  }
}

const isWorkspaceWriteProfile = (profile: CliReviewerSandboxProfile): boolean =>
  profile === "workspace-write" || profile === "workspace-write-net"

type ReviewerAuthority = Pick<ThreadPermission, "approvalPolicy" | "approvalsReviewer">

const selectExplicitAuthorityReviewer = (
  authority: ReviewerAuthority,
  input: {
    sandboxProfile: CliReviewerSandboxProfile
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

/** Surface policy for the default reviewer selection.
 *
 * Precedence:
 *   1. explicit per-thread permission authority (`approvalPolicy` +
 *      `approvalsReviewer`) when present;
 *   2. legacy CLI fallback (`PermissionMode.default` as the old proxy for
 *      "on-request");
 *   3. final fail-closed `user`.
 *
 * The explicit authority path closes the prior drift: the CLI can now honor
 * the same per-thread permission record the permission stack already uses.
 * The `PermissionMode` fallback remains only for threads with no stored
 * permission record yet, preserving current interactive behavior.
 *
 * Legacy fallback order:
 *   1. live auto classifier ⇒ `auto_review`
 *   2. default mode + workspace-write posture + guardian capability
 *      ⇒ `guardian_subagent`
 *   3. everything else ⇒ `user`
 */
export const selectDefaultReviewer = (input: {
  threadPermission: ReviewerAuthority | undefined
  permissionMode: PermissionMode
  sandboxProfile: CliReviewerSandboxProfile
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
