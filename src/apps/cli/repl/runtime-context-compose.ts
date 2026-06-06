import * as readline from "node:readline/promises"
import { createOnConfirmReviewerPort, loadNamedAgents, type NamedAgentResolver } from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import type { ResponsesContinuationStore } from "@/llm"
import type { PermissionStore, ToolAction } from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import { composeRuntimeBootstrapContext, type RuntimeContext } from "@/sdk/runtime"
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

const buildCliApprovalPrompt =
  (deps: { readonly idleMonitor: IdleMonitor; readonly rejectCounter: RejectCounter }) =>
  async (approval: PendingApprovalView): Promise<"approve" | "deny"> => {
    process.stderr.write(`Approval required: ${approval.reason}\n`)
    const ans = await askLine("Approve pending action? [y/N] ")
    const accepted = ans.trim().toLowerCase() === "y"
    if (accepted) deps.rejectCounter.recordAccept()
    else deps.rejectCounter.recordDeny()
    deps.idleMonitor.markActive()
    return accepted ? "approve" : "deny"
  }

export interface ComposeCliRuntimeContextArgs {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly loadPermissionStore: () => Promise<PermissionStore | undefined>
  readonly sandboxProfile: CliReviewerSandboxProfile
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
  readonly envSource?: Readonly<Record<string, string | undefined>>
}

export interface CliRuntimeContextBindings {
  readonly approvalPrompt: (approval: PendingApprovalView) => Promise<"approve" | "deny">
  readonly runtimeContext: RuntimeContext
}

type RuntimeContextAdmissibility = ReturnType<RuntimeContext["admissibility"]>

interface RuntimeConfirmSlot {
  current: (action: ToolAction) => Promise<boolean>
}

const buildSessionMemoryAutoSummarizer = (
  boot: SessionBootstrapResult,
): ReturnType<typeof buildSummarizerLlm> => buildSummarizerLlm(boot.provider, boot.abort.signal)

const buildBootstrapContextArgs = (args: {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly confirmSlot: RuntimeConfirmSlot
  readonly onConfirm: (action: ToolAction) => Promise<boolean>
  readonly planExitPort: ReturnType<typeof createCliPlanExitPort>
  readonly userInputPort: ReturnType<typeof createCliUserInputPort>
  readonly summarizerLlm?: ReturnType<typeof buildSummarizerLlm>
  readonly sandboxProfile: CliReviewerSandboxProfile
  readonly permissionStore: PermissionStore | undefined
  readonly autoReview: ReturnType<typeof createClassifierBackedAutoReview> | undefined
  /** ADR-0428 jun-02 wire — composition-root env view used for the DIRECT
   *  `QUANTA_NETWORK_PROXY` read (mirrors `resolveMemoryConfigFromEnv`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** F2 (round-2) — host-loaded named-agent resolver (`loadNamedAgents(cwd)`).
   *  Threaded onto the overlay so the per-turn AgentConfig carries it. Absent ⇒
   *  no `.quanta/agents` (or load fault) ⇒ overlay slot omitted (byte-identical). */
  readonly namedAgentResolver?: NamedAgentResolver
}): Parameters<typeof composeRuntimeBootstrapContext>[0] => {
  const {
    boot,
    turnStream,
    confirmSlot,
    onConfirm,
    planExitPort,
    userInputPort,
    summarizerLlm,
    sandboxProfile,
    permissionStore,
    autoReview,
    env,
    namedAgentResolver,
  } = args
  // ADR-0428 jun-02 wire — DIRECT env read of `QUANTA_NETWORK_PROXY` (this
  // surface builds its base via the host overlay, not `applyKnobs`). Absent /
  // "0" / empty ⇒ `undefined` ⇒ overlay slot omitted ⇒ NO proxy, byte-identical.
  const networkProxy = resolveNetworkProxyFromEnv(env as NodeJS.ProcessEnv)
  const shellSnapshot = buildShellSnapshotConfig()
  return {
    boot,
    stream: turnStream,
    onConfirm,
    includeSearchPipeline: true,
    overlay: {
      approvalProtocol: { confirmSlot },
      ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
      planExitPort,
      userInputPort,
      decisionEmitter: decisionEmitterFromStream(turnStream),
      admissibilityBuilder: ({ materializeReviewerAgent }) =>
        buildAdmissibility({
          boot,
          onConfirm,
          sandboxProfile,
          permissionStore,
          autoReview,
          materializeReviewerAgent: () => materializeReviewerAgent(boot),
        }),
      ...(shellSnapshot !== undefined ? { shellSnapshot } : {}),
      ...(networkProxy !== undefined ? { networkProxy } : {}),
      // F2 (round-2) — overlay the named-agent resolver when the surface loaded
      // a non-empty `.quanta/agents` registry. Absent ⇒ slot omitted ⇒ the
      // per-turn AgentConfig has no resolver (default-OFF byte-identical).
      ...(namedAgentResolver !== undefined ? { namedAgentResolver } : {}),
    },
  }
}

const buildAdmissibility = (args: {
  readonly boot: SessionBootstrapResult
  readonly onConfirm: (action: ToolAction) => Promise<boolean>
  readonly sandboxProfile: CliReviewerSandboxProfile
  readonly permissionStore: PermissionStore | undefined
  readonly autoReview: ReturnType<typeof createClassifierBackedAutoReview> | undefined
  readonly materializeReviewerAgent: () => ReturnType<
    SessionBootstrapResult["materializeReviewerAgent"]
  >
}): RuntimeContextAdmissibility => {
  const { boot, onConfirm, sandboxProfile, permissionStore, autoReview, materializeReviewerAgent } =
    args
  const userReviewerPort = createOnConfirmReviewerPort({ onConfirm })
  const threadPermission = permissionStore?.getThread(boot.sessionId)
  const reviewerAgent = materializeReviewerAgent()
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
  const surfaceOnConfirm = buildCliOnConfirm({
    idleMonitor: boot.idleMonitor as IdleMonitor,
    rejectCounter: boot.rejectCounter as RejectCounter,
  })
  const confirmSlot: RuntimeConfirmSlot = {
    current: surfaceOnConfirm,
  }
  const onConfirm = async (action: ToolAction): Promise<boolean> =>
    await confirmSlot.current(action)
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
  // F2 (round-2) — load `.quanta/agents` (+ native dir) ONCE per session at this
  // async composition root, using the SESSION-RESOLVED `boot.cwd` (the jailed /
  // resume-switched cwd the surface already settled on — NOT raw `process.cwd()`).
  // Threaded onto the runtime overlay so the interactive REPL's per-turn
  // AgentConfig carries `namedAgentResolver`, giving the primary surface the same
  // named-agent resolution the headless `apps/agent` surface has. FAIL-OPEN +
  // default-OFF: a thrown loader ⇒ `undefined`; an empty registry (no agent dir)
  // ⇒ slot stays absent ⇒ no resolver set ⇒ byte-identical to today.
  const namedAgents = await loadNamedAgents(boot.cwd).catch(() => undefined)
  const namedAgentResolver =
    namedAgents !== undefined && namedAgents.size > 0 ? namedAgents : undefined
  const runtimeContext = await composeRuntimeBootstrapContext({
    ...buildBootstrapContextArgs({
      boot,
      turnStream,
      confirmSlot,
      onConfirm,
      planExitPort,
      userInputPort,
      ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
      sandboxProfile,
      permissionStore,
      autoReview,
      env: args.envSource ?? process.env,
      ...(namedAgentResolver !== undefined ? { namedAgentResolver } : {}),
    }),
    ...(args.convStore !== undefined || args.responsesStore !== undefined
      ? {
          execution: {
            history: boot.history,
            cwd: boot.cwd,
            envSource: args.envSource ?? process.env,
            ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
            ...(args.responsesStore !== undefined ? { responsesStore: args.responsesStore } : {}),
          },
        }
      : {}),
    memoryAuto: {
      env: args.envSource ?? process.env,
      logWarn: (msg: string) => process.stderr.write(`[memory-auto] ${msg}\n`),
    },
  })
  return {
    approvalPrompt: buildCliApprovalPrompt({
      idleMonitor: boot.idleMonitor as IdleMonitor,
      rejectCounter: boot.rejectCounter as RejectCounter,
    }),
    runtimeContext,
  }
}
