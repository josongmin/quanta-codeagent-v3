import * as readline from "node:readline/promises"
import { createOnConfirmReviewerPort } from "@/agent"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { PermissionContext, PermissionMode, PermissionStore, ToolAction } from "@/permission"
import type { StreamPort } from "@/stream"
import { diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import type { IdleMonitor } from "../idle-monitor"
import type { SessionDeps } from "../internal"
import type { RejectCounter } from "../reject-counter"
import { selectDefaultReviewer, type CliReviewerSandboxProfile } from "./reviewer-policy"
import { createCliPlanExitPort, createCliUserInputPort } from "./session-host-ports"

const askLine = async (prompt: string): Promise<string> => {
  const adhoc = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await adhoc.question(prompt)
  } finally {
    adhoc.close()
  }
}

const buildOnConfirm =
  (idleMonitor: IdleMonitor, rejectCounter: RejectCounter) =>
  async (action: ToolAction): Promise<boolean> => {
    if (diffPreviewEnabled()) {
      const preview = await renderActionDiff(action)
      if (preview !== undefined) process.stderr.write(`${preview}\n`)
    }
    const ans = await askLine(`Allow ${action.tool}? [y/N] `)
    const accepted = ans.trim().toLowerCase() === "y"
    if (accepted) rejectCounter.recordAccept()
    else rejectCounter.recordDeny()
    idleMonitor.markActive()
    return accepted
  }

type SessionAdmissibilityDepsFragment = Pick<SessionDeps, "onConfirm"> &
  Required<Pick<SessionDeps, "planExitPort" | "userInputPort">> & {
    admissibility: NonNullable<SessionDeps["admissibility"]>
  }

export interface BuildSessionAdmissibilityDepsOptions {
  idleMonitor: IdleMonitor
  rejectCounter: RejectCounter
  classify: NonNullable<PermissionContext["classify"]> | undefined
  loadPermissionStore: () => Promise<PermissionStore | undefined>
  sessionId: string
  permissionMode: PermissionMode
  sandboxProfile: CliReviewerSandboxProfile
  hasGuardianReview: boolean
  turnStream: StreamPort
}

export interface SessionAdmissibilityBuildResult {
  readonly sessionDeps: SessionAdmissibilityDepsFragment
}

export const buildSessionAdmissibilityDeps = async (
  opts: BuildSessionAdmissibilityDepsOptions,
): Promise<SessionAdmissibilityBuildResult> => {
  const onConfirm = buildOnConfirm(opts.idleMonitor, opts.rejectCounter)
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const autoReview =
    opts.classify !== undefined
      ? createClassifierBackedAutoReview({
          classify: opts.classify,
          userReview: userReviewerPort.userReview,
        })
      : undefined
  const reviewerPort =
    autoReview !== undefined
      ? createOnConfirmReviewerPort({ onConfirm, autoReview })
      : userReviewerPort
  const permissionStore = await opts.loadPermissionStore()
  const threadPermission = permissionStore?.getThread(opts.sessionId)
  const defaultReviewer = selectDefaultReviewer({
    ...(threadPermission !== undefined ? { threadPermission } : {}),
    permissionMode: opts.permissionMode,
    sandboxProfile: opts.sandboxProfile,
    hasAutoReview: autoReview !== undefined,
    hasGuardianReview: opts.hasGuardianReview,
  })

  return {
    sessionDeps: {
      onConfirm,
      admissibility: {
        ...(permissionStore !== undefined ? { permissionStore } : {}),
        reviewerPort,
        defaultReviewer,
      },
      planExitPort: createCliPlanExitPort({ ask: askLine }),
      userInputPort: createCliUserInputPort({ ask: askLine, stream: opts.turnStream }),
    },
  }
}
