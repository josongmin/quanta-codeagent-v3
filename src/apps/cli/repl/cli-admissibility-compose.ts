import { createOnConfirmReviewerPort, type ConfirmDecision } from "@/agent"
import { type SessionBootstrapResult } from "@/host/bootstrap"
import {
  APPROVAL_LADDER,
  CircumventionTracker,
  type PermissionStore,
  parseApprovalLadderName,
  type ReviewerSandboxProfile,
  selectDefaultReviewer,
  type ToolAction,
} from "@/permission"
import type { RuntimeContext } from "@/sdk/runtime"
import { runtimeConfig } from "@/shared"

export type CliRuntimeContextAdmissibility = ReturnType<RuntimeContext["admissibility"]>

export const ladderAutoReviewEnabled = (): boolean => {
  const rung = parseApprovalLadderName(runtimeConfig().approvalLadder)
  return (
    runtimeConfig().autoReview ||
    (rung !== undefined && APPROVAL_LADDER[rung].approvalsReviewer === "agent")
  )
}

export const buildAdmissibility = (args: {
  readonly boot: SessionBootstrapResult
  readonly onConfirm: (action: ToolAction) => Promise<boolean | ConfirmDecision>
  readonly sandboxProfile: ReviewerSandboxProfile
  readonly permissionStore: PermissionStore | undefined
  readonly autoReview:
    | ReturnType<typeof import("@/agent/reviewer-port").createClassifierBackedAutoReview>
    | undefined
  readonly materializeReviewerAgent: () => ReturnType<
    SessionBootstrapResult["materializeReviewerAgent"]
  >
}): CliRuntimeContextAdmissibility => {
  const { boot, onConfirm, sandboxProfile, permissionStore, autoReview, materializeReviewerAgent } =
    args
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const autoReviewEnabled = ladderAutoReviewEnabled()
  const threadPermission = permissionStore?.getThread(boot.sessionId)
  const reviewerAgent = materializeReviewerAgent()
  const guardianReview =
    reviewerAgent !== undefined
      ? boot.createSubagentBackedGuardianReview({
          reviewer: reviewerAgent,
          signal: boot.abort.signal,
        })
      : undefined
  const guardianAssess =
    reviewerAgent !== undefined && runtimeConfig().guardianAssessor
      ? boot.createSubagentBackedGuardianAssess({
          reviewer: reviewerAgent,
          signal: boot.abort.signal,
        })
      : undefined
  const reviewerPort =
    autoReview !== undefined || guardianReview !== undefined || guardianAssess !== undefined
      ? createOnConfirmReviewerPort({
          onConfirm,
          ...(autoReview !== undefined ? { autoReview } : {}),
          ...(guardianReview !== undefined ? { guardianReview } : {}),
          ...(guardianAssess !== undefined ? { guardianAssess } : {}),
        })
      : userReviewerPort
  const circumventionTracker = runtimeConfig().circumventDetect
    ? new CircumventionTracker()
    : undefined
  const allowlistEscalated = new Set<string>()
  return {
    ...(permissionStore !== undefined ? { permissionStore } : {}),
    reviewerPort,
    allowlistEscalated,
    defaultReviewer: selectDefaultReviewer({
      threadPermission,
      permissionMode: boot.mode,
      sandboxProfile,
      hasAutoReview: autoReview !== undefined,
      hasGuardianReview: guardianReview !== undefined,
      autoReviewEnabled,
    }),
    ...(circumventionTracker !== undefined ? { circumventionTracker } : {}),
  }
}
