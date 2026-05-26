import * as readline from "node:readline/promises"
import { createOnConfirmReviewerPort } from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { PermissionStore, ToolAction } from "@/permission"
import {
  composeRuntimeBootstrapContext,
  type RuntimeContext,
} from "@/sdk/runtime"
import { decisionEmitterFromStream, type StreamPort } from "@/stream"
import { diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import type { IdleMonitor } from "../idle-monitor"
import { buildShellSnapshotConfig, buildSummarizerLlm } from "../internal"
import type { RejectCounter } from "../reject-counter"
import { type CliReviewerSandboxProfile, selectDefaultReviewer } from "./reviewer-policy"
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

export interface ComposeCliRuntimeContextArgs {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly loadPermissionStore: () => Promise<PermissionStore | undefined>
  readonly sandboxProfile: CliReviewerSandboxProfile
  readonly convStore?: ConversationCheckpointStore
  readonly envSource?: Readonly<Record<string, string | undefined>>
}

export interface CliRuntimeContextBindings {
  readonly runtimeContext: RuntimeContext
}

type RuntimeContextAdmissibility = ReturnType<RuntimeContext["admissibility"]>

const buildSessionMemoryAutoSummarizer = (
  boot: SessionBootstrapResult,
): ReturnType<typeof buildSummarizerLlm> => buildSummarizerLlm(boot.provider, boot.abort.signal)

const buildBootstrapContextArgs = (args: {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly onConfirm: (action: ToolAction) => Promise<boolean>
  readonly planExitPort: ReturnType<typeof createCliPlanExitPort>
  readonly userInputPort: ReturnType<typeof createCliUserInputPort>
  readonly summarizerLlm?: ReturnType<typeof buildSummarizerLlm>
}): Parameters<typeof composeRuntimeBootstrapContext>[0] => {
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
  readonly runtimeContext: RuntimeContext
}): RuntimeContextAdmissibility => {
  const { boot, onConfirm, sandboxProfile, permissionStore, autoReview, runtimeContext } = args
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const threadPermission = permissionStore?.getThread(boot.sessionId)
  const reviewerAgent = runtimeContext.materializeReviewerAgent(boot)
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

export const composeCliRuntimeContext = async (
  args: ComposeCliRuntimeContextArgs,
): Promise<CliRuntimeContextBindings> => {
  const { boot, turnStream, loadPermissionStore, sandboxProfile } = args
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
  const runtimeContext = await composeRuntimeBootstrapContext({
    ...buildBootstrapContextArgs({
      boot,
      turnStream,
      onConfirm,
      planExitPort,
      userInputPort,
      ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
    }),
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
  const admissibility = buildAdmissibility({
    boot,
    onConfirm,
    sandboxProfile,
    permissionStore,
    autoReview,
    runtimeContext,
  })
  if (admissibility !== undefined) runtimeContext.withAdmissibility(admissibility)
  return { runtimeContext }
}
