import { createOnConfirmReviewerPort } from "@/agent"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { PermissionStore, ToolAction } from "@/permission"
import type { StreamPort } from "@/stream"
import {
  buildShellSnapshotConfig,
  buildSummarizerLlm,
  type SessionDeps,
} from "../internal"
import { selectDefaultReviewer, type CliReviewerSandboxProfile } from "./reviewer-policy"
import { createCliPlanExitPort, createCliUserInputPort } from "./session-host-ports"
import type { SessionBootstrapResult } from "./session-bootstrap"

export const buildCliOnConfirm =
  (
    deps: {
      readonly idleMonitor: {
        markActive: () => void
      }
      readonly rejectCounter: {
        recordAccept: () => void
        recordDeny: () => void
      }
      readonly ask: (prompt: string) => Promise<string>
      readonly renderActionDiff: (action: ToolAction) => Promise<string | undefined>
      readonly diffPreviewEnabled: () => boolean
    },
  ) =>
  async (action: ToolAction): Promise<boolean> => {
    if (deps.diffPreviewEnabled()) {
      const preview = await deps.renderActionDiff(action)
      if (preview !== undefined) process.stderr.write(`${preview}\n`)
    }
    const ans = await deps.ask(`Allow ${action.tool}? [y/N] `)
    const accepted = ans.trim().toLowerCase() === "y"
    if (accepted) deps.rejectCounter.recordAccept()
    else deps.rejectCounter.recordDeny()
    deps.idleMonitor.markActive()
    return accepted
  }

export interface ComposeCliSessionDepsArgs {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly onConfirm: (action: ToolAction) => Promise<boolean>
  readonly ask: (prompt: string) => Promise<string>
  readonly loadPermissionStore: () => Promise<PermissionStore | undefined>
  readonly sandboxProfile: CliReviewerSandboxProfile
}

export interface CliAdmissibilityBindings {
  readonly permissionStore: PermissionStore | undefined
  readonly sessionDeps: SessionDeps
}

/** Compose the CLI-owned reviewer, plan-exit, and user-input seams into the
 *  session deps record the loop consumes. */
export const composeCliSessionDeps = async (
  args: ComposeCliSessionDepsArgs,
): Promise<CliAdmissibilityBindings> => {
  const { boot, turnStream, onConfirm, ask, loadPermissionStore, sandboxProfile } = args
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const autoReview =
    boot.permission.classify !== undefined
      ? createClassifierBackedAutoReview({
          classify: boot.permission.classify,
          userReview: userReviewerPort.userReview,
        })
      : undefined
  const reviewerPort =
    autoReview !== undefined
      ? createOnConfirmReviewerPort({ onConfirm, autoReview })
      : userReviewerPort
  const permissionStore = await loadPermissionStore()
  const threadPermission = permissionStore?.getThread(boot.sessionId)
  const defaultReviewer = selectDefaultReviewer({
    threadPermission,
    permissionMode: boot.mode,
    sandboxProfile,
    hasAutoReview: autoReview !== undefined,
    hasGuardianReview: boot.tooling.subagentConfig !== undefined,
  })
  const planExitPort = createCliPlanExitPort({ ask })
  const userInputPort = createCliUserInputPort({ ask, stream: turnStream })
  const sessionDeps: SessionDeps = {
    llm: boot.llm,
    registry: boot.tooling.registry,
    stream: turnStream,
    permission: boot.permission,
    system: boot.system,
    cwd: boot.cwd,
    maxTurns: boot.maxTurns,
    signal: boot.abort.signal,
    onConfirm,
    store: boot.tooling.store,
    sessionId: boot.sessionId,
    embedder: boot.tooling.embedder,
    memoryConfig: boot.tooling.memoryConfig,
    planMode: boot.features.planMode,
    metrics: boot.features.metrics,
    run: boot.run,
    subagentConfig: boot.tooling.subagentConfig,
    skillsConfig: boot.tooling.skillsConfig,
    compactionBreakerConfig: boot.tooling.compactionBreakerConfig,
    verifyGuardConfig: boot.tooling.verifyGuardConfig,
    summarizerLlm: buildSummarizerLlm(boot.provider, boot.abort.signal),
    admissibility: {
      ...(permissionStore !== undefined ? { permissionStore } : {}),
      reviewerPort,
      defaultReviewer,
    },
    planExitPort,
    userInputPort,
    onShellEvent: boot.onShellEvent,
    workMetricsSink: boot.workMetricsSink,
    ...(boot.lifecycleFollowUpQueue !== undefined
      ? { followUpQueue: boot.lifecycleFollowUpQueue }
      : {}),
    ...(boot.planStore !== undefined ? { planStore: boot.planStore } : {}),
    ...((): { shellSnapshot?: SessionDeps["shellSnapshot"] } => {
      const cfg = buildShellSnapshotConfig()
      return cfg !== undefined ? { shellSnapshot: cfg } : {}
    })(),
  }
  return { permissionStore, sessionDeps }
}
