import * as readline from "node:readline/promises"
import { createOnConfirmReviewerPort } from "@/agent"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { PermissionStore, ToolAction } from "@/permission"
import { assembleConfig, type SessionDeps } from "@/runner/assemble"
import { decisionEmitterFromStream, type StreamPort } from "@/stream"
import { diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import type { IdleMonitor } from "../idle-monitor"
import { buildShellSnapshotConfig, buildSummarizerLlm } from "../internal"
import type { RejectCounter } from "../reject-counter"
import { type CliReviewerSandboxProfile, selectDefaultReviewer } from "./reviewer-policy"
import { createCliPlanExitPort, createCliUserInputPort } from "./session-host-ports"
import { buildSessionMemoryAutoWires } from "./session-memory-auto"

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
}

export interface CliAdmissibilityBindings {
  readonly sessionDeps: SessionDeps
}

const buildSessionMemoryAutoDeps = async (
  boot: SessionBootstrapResult,
): Promise<{
  readonly summarizerLlm?: ReturnType<typeof buildSummarizerLlm>
  readonly sessionCtx?: string
  readonly memoryConsolidator?: SessionDeps["memoryConsolidator"]
  readonly stage1OutputsStore?: SessionDeps["stage1OutputsStore"]
}> => {
  const summarizerLlm = buildSummarizerLlm(boot.provider, boot.abort.signal)
  const sessionMemoryAuto = await buildSessionMemoryAutoWires({
    env: process.env,
    llm: boot.llm,
    ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
    sessionId: boot.sessionId,
    signal: boot.abort.signal,
    logWarn: (msg: string) => process.stderr.write(`[memory-auto] ${msg}\n`),
  })
  return {
    ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
    ...(sessionMemoryAuto?.sessionCtx !== undefined
      ? { sessionCtx: sessionMemoryAuto.sessionCtx }
      : {}),
    ...(sessionMemoryAuto?.memoryConsolidator !== undefined
      ? { memoryConsolidator: sessionMemoryAuto.memoryConsolidator }
      : {}),
    ...(sessionMemoryAuto?.stage1OutputsStore !== undefined
      ? { stage1OutputsStore: sessionMemoryAuto.stage1OutputsStore }
      : {}),
  }
}

const buildBaseSessionDeps = (args: {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly onConfirm: (action: ToolAction) => Promise<boolean>
  readonly planExitPort: ReturnType<typeof createCliPlanExitPort>
  readonly userInputPort: ReturnType<typeof createCliUserInputPort>
  readonly autoDeps: Awaited<ReturnType<typeof buildSessionMemoryAutoDeps>>
}): SessionDeps => {
  const { boot, turnStream, onConfirm, planExitPort, userInputPort, autoDeps } = args
  const base: SessionDeps = {
    llm: boot.llm,
    registry: boot.tooling.registry,
    stream: turnStream,
    permission: boot.permission,
    system: boot.system,
    systemSource: boot.systemSource,
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
    searchPipeline: boot.tooling.searchPipeline,
    summarizerLlm: autoDeps.summarizerLlm ?? undefined,
    planExitPort,
    userInputPort,
    ...(boot.toolProfileState !== undefined ? { toolProfileState: boot.toolProfileState } : {}),
    ...(boot.identityModeState !== undefined ? { identityModeState: boot.identityModeState } : {}),
    ...(boot.focusChain !== undefined ? { focusChain: boot.focusChain } : {}),
    onShellEvent: boot.onShellEvent,
    workMetricsSink: boot.workMetricsSink,
    sessionEffort: () => boot.effortStore.get(),
    decisionEmitter: decisionEmitterFromStream(turnStream),
  }
  if (autoDeps.sessionCtx !== undefined) base.sessionCtx = autoDeps.sessionCtx
  if (autoDeps.memoryConsolidator !== undefined) {
    base.memoryConsolidator = autoDeps.memoryConsolidator
  }
  if (autoDeps.stage1OutputsStore !== undefined) {
    base.stage1OutputsStore = autoDeps.stage1OutputsStore
  }
  if (boot.lifecycleFollowUpQueue !== undefined) {
    base.followUpQueue = boot.lifecycleFollowUpQueue
  }
  if (boot.planStore !== undefined) {
    base.planStore = boot.planStore
  }
  const shellSnapshot = buildShellSnapshotConfig()
  if (shellSnapshot !== undefined) {
    base.shellSnapshot = shellSnapshot
  }
  return base
}

const buildAdmissibility = (args: {
  readonly boot: SessionBootstrapResult
  readonly onConfirm: (action: ToolAction) => Promise<boolean>
  readonly sandboxProfile: CliReviewerSandboxProfile
  readonly permissionStore: PermissionStore | undefined
  readonly autoReview: ReturnType<typeof createClassifierBackedAutoReview> | undefined
  readonly baseSessionDeps: SessionDeps
}): SessionDeps["admissibility"] => {
  const { boot, onConfirm, sandboxProfile, permissionStore, autoReview, baseSessionDeps } = args
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const threadPermission = permissionStore?.getThread(boot.sessionId)
  const reviewerAgent = boot.materializeReviewerAgent(assembleConfig([], baseSessionDeps))
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
  const autoDeps = await buildSessionMemoryAutoDeps(boot)
  const baseSessionDeps = buildBaseSessionDeps({
    boot,
    turnStream,
    onConfirm,
    planExitPort,
    userInputPort,
    autoDeps,
  })
  baseSessionDeps.admissibility = buildAdmissibility({
    boot,
    onConfirm,
    sandboxProfile,
    permissionStore,
    autoReview,
    baseSessionDeps,
  })
  return { sessionDeps: baseSessionDeps }
}
