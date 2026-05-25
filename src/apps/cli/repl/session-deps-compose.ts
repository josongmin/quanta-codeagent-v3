import * as readline from "node:readline/promises"
import { createOnConfirmReviewerPort } from "@/agent"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { PermissionStore, ToolAction } from "@/permission"
import { decisionEmitterFromStream, type StreamPort } from "@/stream"
import { diffPreviewEnabled, renderActionDiff } from "../diff-preview"
import type { IdleMonitor } from "../idle-monitor"
import { buildShellSnapshotConfig, buildSummarizerLlm, type SessionDeps } from "../internal"
import type { RejectCounter } from "../reject-counter"
import { type CliReviewerSandboxProfile, selectDefaultReviewer } from "./reviewer-policy"
import type { SessionBootstrapResult } from "./session-bootstrap"
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
}

export interface CliAdmissibilityBindings {
  readonly sessionDeps: SessionDeps
}

/** Compose the CLI-owned reviewer, plan-exit, and user-input seams into the
 *  session deps record the loop consumes. */
export const composeCliSessionDeps = async (
  args: ComposeCliSessionDepsArgs,
): Promise<CliAdmissibilityBindings> => {
  const { boot, turnStream, loadPermissionStore, sandboxProfile } = args
  const onConfirm = buildCliOnConfirm({
    idleMonitor: boot.idleMonitor,
    rejectCounter: boot.rejectCounter,
  })
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const autoReview =
    boot.permission.classify !== undefined
      ? createClassifierBackedAutoReview({
          classify: boot.permission.classify,
          userReview: userReviewerPort.userReview,
        })
      : undefined
  const permissionStore = await loadPermissionStore()
  const threadPermission = permissionStore?.getThread(boot.sessionId)
  const planExitPort = createCliPlanExitPort({ ask: askLine })
  const userInputPort = createCliUserInputPort({ ask: askLine, stream: turnStream })
  const baseSessionDeps: SessionDeps = {
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
    summarizerLlm: buildSummarizerLlm(boot.provider, boot.abort.signal),
    planExitPort,
    userInputPort,
    ...(boot.toolProfileState !== undefined ? { toolProfileState: boot.toolProfileState } : {}),
    ...(boot.identityModeState !== undefined ? { identityModeState: boot.identityModeState } : {}),
    ...(boot.focusChain !== undefined ? { focusChain: boot.focusChain } : {}),
    onShellEvent: boot.onShellEvent,
    workMetricsSink: boot.workMetricsSink,
    sessionEffort: () => boot.effortStore.get(),
    // ADR-0269 Phase 3 closure — wire the gate-decision emitter to the SAME
    // stream tee that already feeds debug-tracer / decision-counter-sink /
    // OTLP exporter. The emitter just forwards `safeEmitDecision(stream, ev)`,
    // so a `decision` AgentEvent reaches every existing consumer without
    // another fan-out. Without this slot all 6 caller sites (Phase 2 + Phase 3)
    // silently no-op — the helpers are wired but their emitter handle is
    // `undefined`, so the entire developer-mode observability surface is
    // empty in production. This is the one-line wire that closes the loop.
    decisionEmitter: decisionEmitterFromStream(turnStream),
    ...(boot.lifecycleFollowUpQueue !== undefined
      ? { followUpQueue: boot.lifecycleFollowUpQueue }
      : {}),
    ...(boot.planStore !== undefined ? { planStore: boot.planStore } : {}),
    ...((): { shellSnapshot?: SessionDeps["shellSnapshot"] } => {
      const cfg = buildShellSnapshotConfig()
      return cfg !== undefined ? { shellSnapshot: cfg } : {}
    })(),
  }
  const guardianReview = boot.guardianReview
  const reviewerPort =
    autoReview !== undefined || guardianReview !== undefined
      ? createOnConfirmReviewerPort({
          onConfirm,
          ...(autoReview !== undefined ? { autoReview } : {}),
          ...(guardianReview !== undefined ? { guardianReview } : {}),
        })
      : userReviewerPort
  const defaultReviewer = selectDefaultReviewer({
    threadPermission,
    permissionMode: boot.mode,
    sandboxProfile,
    hasAutoReview: autoReview !== undefined,
    hasGuardianReview: guardianReview !== undefined,
  })
  const sessionDeps: SessionDeps = {
    ...baseSessionDeps,
    admissibility: {
      ...(permissionStore !== undefined ? { permissionStore } : {}),
      reviewerPort,
      defaultReviewer,
    },
  }
  return { sessionDeps }
}
