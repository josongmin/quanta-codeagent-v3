import type { PermissionMode, ReviewerTier } from "@/permission"

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

/** Surface policy for the default reviewer selection.
 *
 * Current CLI authority is narrower than the full ADR-0029 matrix: it knows
 * the session's coarse `PermissionMode`, the operator-selected shell sandbox
 * posture, and which reviewer capabilities are actually live. It does NOT yet
 * have a first-class approval-policy object (`never|on-request|...`), so
 * `PermissionMode.default` is the closest live approximation of an
 * "on-request" posture.
 *
 * Order:
 *   1. live auto classifier ⇒ `auto_review`
 *   2. default mode + workspace-write posture + guardian capability
 *      ⇒ `guardian_subagent`
 *   3. everything else ⇒ `user`
 */
export const selectDefaultReviewer = (input: {
  permissionMode: PermissionMode
  sandboxProfile: CliReviewerSandboxProfile
  hasAutoReview: boolean
  hasGuardianReview: boolean
}): ReviewerTier => {
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
