import * as readline from "node:readline/promises"
import { createOnConfirmReviewerPort } from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { PermissionStore, ToolAction } from "@/permission"
import {
  composeBootstrapRuntimeDeps,
  materializeReviewerAgent,
  type RuntimeSessionDeps,
} from "@/sdk/runtime/bridge"
import { decisionEmitterFromStream, type StreamPort } from "@/stream"
import { diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import type { IdleMonitor } from "../idle-monitor"
import { buildShellSnapshotConfig, buildSummarizerLlm } from "../internal"
import type { RejectCounter } from "../reject-counter"
import { type CliReviewerSandboxProfile, selectDefaultReviewer } from "./reviewer-policy"
import { type CliRuntimeBridge, createCliRuntimeBridge } from "./runtime-bridge"
import { createCliPlanExitPort, createCliUserInputPort } from "./session-host-ports"

const askLine = async (prompt: string): Promise<string> => {
  const adhoc = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await adhoc.question(prompt)
  } finally {
    adhoc.close()
  }
}

const buildCliOnConfirm =
  (deps: { readonly idleMonitor: IdleMonitor; readonly rejectCounter: RejectCounter }) =>
  async (action: ToolAction): Promise<boolean> => {
    if (diffPreviewEnabled()) {
      const preview = await renderActionDiff(action)
      if (preview !== undefined) process.stderr.write(`${preview}\n`)
    }
    const ans = await askLine(`Allow ${action.tool}? [y/N] `)
    const accepted = ans.trim().toLowerCase() === "y"
    if (accepted) deps.rejectCounter.recordAccept()
    else deps.rejectCounter.recordDeny()
    deps.idleMonitor.markActive()
    return accepted
  }

export interface ComposeCliSessionDepsArgs {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly loadPermissionStore: () => Promise<PermissionStore | undefined>
  readonly sandboxProfile: CliReviewerSandboxProfile
  readonly convStore?: ConversationCheckpointStore
  readonly envSource?: Readonly<Record<string, string | undefined>>
}

export interface CliAdmissibilityBindings {
  readonly runtimeBridge: CliRuntimeBridge
}

const buildSessionMemoryAutoSummarizer = (
  boot: SessionBootstrapResult,
): ReturnType<typeof buildSummarizerLlm> => buildSummarizerLlm(boot.provider, boot.abort.signal)

const buildBaseSessionDeps = (args: {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly onConfirm: (action: ToolAction) => Promise<boolean>
  readonly planExitPort: ReturnType<typeof createCliPlanExitPort>
  readonly userInputPort: ReturnType<typeof createCliUserInputPort>
  readonly summarizerLlm?: ReturnType<typeof buildSummarizerLlm>
}): Parameters<typeof composeBootstrapRuntimeDeps>[0] => {
  const { boot, turnStream, onConfirm, planExitPort, userInputPort, summarizerLlm } = args
  const shellSnapshot = buildShellSnapshotConfig()
  return {
    boot,
    stream: turnStream,
    onConfirm,
    includeSearchPipeline: true,
    overlay: {
      ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
      planExitPort,
      userInputPort,
      decisionEmitter: decisionEmitterFromStream(turnStream),
      ...(shellSnapshot !== undefined ? { shellSnapshot } : {}),
    },
  }
}

const buildAdmissibility = (args: {
  readonly boot: SessionBootstrapResult
  readonly onConfirm: (action: ToolAction) => Promise<boolean>
  readonly sandboxProfile: CliReviewerSandboxProfile
  readonly permissionStore: PermissionStore | undefined
  readonly autoReview: ReturnType<typeof createClassifierBackedAutoReview> | undefined
  readonly baseSessionDeps: RuntimeSessionDeps
}): RuntimeSessionDeps["admissibility"] => {
  const { boot, onConfirm, sandboxProfile, permissionStore, autoReview, baseSessionDeps } = args
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const threadPermission = permissionStore?.getThread(boot.sessionId)
  const reviewerAgent = materializeReviewerAgent(boot, baseSessionDeps)
  const guardianReview =
    reviewerAgent !== undefined
      ? boot.createSubagentBackedGuardianReview({
          reviewer: reviewerAgent,
          signal: boot.abort.signal,
        })
      : undefined
  const reviewerPort =
    autoReview !== undefined || guardianReview !== undefined
      ? createOnConfirmReviewerPort({
          onConfirm,
          ...(autoReview !== undefined ? { autoReview } : {}),
          ...(guardianReview !== undefined ? { guardianReview } : {}),
        })
      : userReviewerPort
  return {
    ...(permissionStore !== undefined ? { permissionStore } : {}),
    reviewerPort,
    defaultReviewer: selectDefaultReviewer({
      threadPermission,
      permissionMode: boot.mode,
      sandboxProfile,
      hasAutoReview: autoReview !== undefined,
      hasGuardianReview: guardianReview !== undefined,
    }),
  }
}

/** Compose the CLI-owned reviewer, plan-exit, and user-input seams into the
 *  session deps record the loop consumes. */
export const composeCliSessionDeps = async (
  args: ComposeCliSessionDepsArgs,
): Promise<CliAdmissibilityBindings> => {
  const { boot, turnStream, loadPermissionStore, sandboxProfile } = args
  // ADR-0299 — the host result types these ports as opaque (`unknown`); the
  // CLI surface owns the real shapes (touch node:fs / node:os) so we narrow
  // them back at the seam.
  const onConfirm = buildCliOnConfirm({
    idleMonitor: boot.idleMonitor as IdleMonitor,
    rejectCounter: boot.rejectCounter as RejectCounter,
  })
  const autoReviewUserPort = createOnConfirmReviewerPort({ onConfirm })
  const autoReview =
    boot.permission.classify !== undefined
      ? createClassifierBackedAutoReview({
          classify: boot.permission.classify,
          userReview: autoReviewUserPort.userReview,
        })
      : undefined
  const permissionStore = await loadPermissionStore()
  const planExitPort = createCliPlanExitPort({ ask: askLine })
  const userInputPort = createCliUserInputPort({ ask: askLine, stream: turnStream })
  const summarizerLlm = buildSessionMemoryAutoSummarizer(boot)
  const composePlan = buildBaseSessionDeps({
    boot,
    turnStream,
    onConfirm,
    planExitPort,
    userInputPort,
    ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
  })
  const sessionDeps = await composeBootstrapRuntimeDeps({
    ...composePlan,
    ...(args.convStore !== undefined
      ? {
          execution: {
            history: boot.history,
            cwd: boot.cwd,
            convStore: args.convStore,
            envSource: args.envSource ?? process.env,
          },
        }
      : {}),
    memoryAuto: {
      env: args.envSource ?? process.env,
      logWarn: (msg: string) => process.stderr.write(`[memory-auto] ${msg}\n`),
    },
  })
  sessionDeps.admissibility = buildAdmissibility({
    boot,
    onConfirm,
    sandboxProfile,
    permissionStore,
    autoReview,
    baseSessionDeps: sessionDeps,
  })
  return { runtimeBridge: createCliRuntimeBridge(sessionDeps) }
}
