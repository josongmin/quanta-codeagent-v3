import { gitWriteProtectReason } from "@/permission"
import { runtimeConfig } from "@/shared"
import type { WorkingStateHandle } from "@/tool"
import { type InterruptRouter, makeInterruptRouter, type ToolContext } from "@/tool"
import { bindWriteBudgetTurn } from "@/tool/_shared/write-budget"
import type { resolveCollaborationMode } from "../mode"
import { planStoreToMutator } from "../plan/mutator-adapter"
import { runPlanExitFlow } from "../plan-exit-flow"
import { materializeReviewerAgent } from "../tier1/reviewer-subagent"
import type { AgentConfig } from "../types"

/** jun-6 (RFC jun-6-tool-interrupt-behavior) — build the per-call interrupt
 *  router for a `block` tool when the knob is ON. Returns `undefined` when the
 *  knob is off OR the tool's declared `interruptBehavior()` is `"cancel"` (the
 *  common case) ⇒ the caller threads the raw signal + no seam (byte-identical).
 *  The watchdog scheduler is the real `setTimeout`/`clearTimeout` and the clock
 *  is `Date.now` (the composition root for the production seam); the cap comes
 *  from `runtimeConfig().criticalSectionMaxMs`. */
export const maybeBuildInterruptRouter = (
  config: AgentConfig,
  toolName: string,
): { router: InterruptRouter; signal: AbortSignal } | undefined => {
  if (!runtimeConfig().toolInterruptBlock) return undefined
  if (config.registry.interruptBehavior(toolName) !== "block") return undefined
  const derived = new AbortController()
  const router = makeInterruptRouter({
    source: config.signal,
    derived,
    now: Date.now,
    maxMs: runtimeConfig().criticalSectionMaxMs,
    scheduler: {
      schedule(ms, cb) {
        const id = setTimeout(cb, ms)
        return () => clearTimeout(id)
      },
    },
  })
  return { router, signal: derived.signal }
}

const buildRequestPlanExit = (
  config: AgentConfig,
  collabMode: ReturnType<typeof resolveCollaborationMode>,
): ToolContext["requestPlanExit"] => {
  const planExitPort = config.planExitPort
  return planExitPort !== undefined
    ? async (plan: string) => {
        const outcome = await runPlanExitFlow(collabMode, plan, planExitPort)
        config.onPlanExitOutcome?.({ plan, outcome })
        return outcome
      }
    : undefined
}

/** Build the plan-ENTRY requester — the inverse of {@link buildRequestPlanExit}.
 *  Gated on the SAME `planExitPort` slot (entry ships only when a clean exit is
 *  also wired). Fire-and-forget: it just relays the reason to
 *  `config.onPlanEnterRequest`; the loop flips mode at the next turn boundary. */
const buildEnterPlanMode = (config: AgentConfig): ToolContext["enterPlanMode"] =>
  config.planExitPort !== undefined
    ? (reason: string) => {
        config.onPlanEnterRequest?.({ reason })
      }
    : undefined

/** ADR-0416 sibling-identity fix — project the STABLE mailbox labels onto the
 *  ToolContext partial. Each label is omitted when its `AgentConfig` slot is
 *  absent (root session / legacy caller) so the subagent-mailbox tools fall
 *  back to the depth-derived label and the ctx stays byte-identical. Extracted
 *  from `buildToolContext` to keep that builder under the cognitive-complexity
 *  cap. */
const mailboxLabels = (
  config: AgentConfig,
): { agentLabel?: string; parentAgentLabel?: string } => ({
  ...(config.mailboxAgentId !== undefined ? { agentLabel: config.mailboxAgentId } : {}),
  ...(config.mailboxParentId !== undefined ? { parentAgentLabel: config.mailboxParentId } : {}),
})

const buildSessionSeams = (args: {
  config: AgentConfig
  workingState: WorkingStateHandle | undefined
  requestPlanExit: ToolContext["requestPlanExit"]
  enterPlanMode: ToolContext["enterPlanMode"]
  reviewerAgent: ToolContext["reviewerAgent"]
}): Partial<ToolContext> => {
  const { config, workingState, requestPlanExit, enterPlanMode, reviewerAgent } = args
  const shellSnapshot = config.shellSnapshotSession?.currentSeam()
  return {
    ...(workingState !== undefined ? { workingState } : {}),
    ...(requestPlanExit !== undefined ? { requestPlanExit } : {}),
    ...(enterPlanMode !== undefined ? { enterPlanMode } : {}),
    ...(reviewerAgent !== undefined ? { reviewerAgent } : {}),
    ...(config.onShellEvent !== undefined ? { onShellEvent: config.onShellEvent } : {}),
    ...(config.planStore !== undefined
      ? { planMutator: planStoreToMutator(config.planStore) }
      : {}),
    ...(config.userInputPort !== undefined ? { requestUserInput: config.userInputPort } : {}),
    ...(config.backgroundConsentPort !== undefined
      ? { requestBackgroundConsent: config.backgroundConsentPort }
      : {}),
    ...(shellSnapshot !== undefined ? { shellSnapshot } : {}),
    ...(config.sessionConfigPort !== undefined ? { sessionConfig: config.sessionConfigPort } : {}),
    ...(config.readFileState !== undefined ? { readFileState: config.readFileState } : {}),
  }
}

const buildEditSeams = (config: AgentConfig): Partial<ToolContext> => ({
  ...(config.fastApplyFallback !== undefined
    ? { fastApplyFallback: config.fastApplyFallback }
    : {}),
  ...(config.fastApplyMerge !== undefined ? { fastApplyMerge: config.fastApplyMerge } : {}),
  ...(config.fastApplyMergeReview !== undefined
    ? { fastApplyMergeReview: config.fastApplyMergeReview }
    : {}),
  ...(runtimeConfig().editAutoFuzzy ? { autoEscalateFuzzy: true } : {}),
  ...(runtimeConfig().editFreshHash ? { editFreshHash: true } : {}),
})

const buildObserverSeams = (config: AgentConfig, toolCallId: string): Partial<ToolContext> => ({
  ...(config.proxyEnv !== undefined ? { proxyEnv: config.proxyEnv } : {}),
  ...(config.localEnv !== undefined ? { localEnv: config.localEnv } : {}),
  ...(config.onToolDiff !== undefined ? { toolDiff: config.onToolDiff, toolCallId } : {}),
  ...(config.vcsEventSink !== undefined ? { vcsEventSink: config.vcsEventSink } : {}),
  ...(config.progressSink !== undefined ? { progressSink: config.progressSink } : {}),
  ...(config.fileHistory !== undefined ? { fileHistory: config.fileHistory } : {}),
})

const buildCodeAndWorkspaceSeams = (
  config: AgentConfig,
  toolCallId: string,
): Partial<ToolContext> => {
  const budget = config.writeBudget
  const max = runtimeConfig().writeBudgetMax
  const activeWorktree = config.activeWorktreeSlot?.current()
  return {
    ...(config.codeCellDispatchFactory !== undefined
      ? { codeCellDispatch: config.codeCellDispatchFactory(toolCallId) }
      : {}),
    ...(config.codeCellSurfaceTools !== undefined
      ? { codeCellSurface: config.codeCellSurfaceTools() }
      : {}),
    ...(runtimeConfig().globWriteGuard ? { globWriteGuard: true } : {}),
    ...(budget !== undefined && max !== undefined
      ? { writeBudget: bindWriteBudgetTurn(budget, config.run?.turn ?? 0, max) }
      : {}),
    ...(config.activeWorktreeSlot !== undefined
      ? {
          worktreeSlot: config.activeWorktreeSlot,
          ...(activeWorktree !== undefined ? { activeWorktree } : {}),
        }
      : {}),
  }
}

export const buildToolContext = (args: {
  config: AgentConfig
  workingState: WorkingStateHandle | undefined
  collabMode: ReturnType<typeof resolveCollaborationMode>
  toolCallId: string
  /** jun-6 tool-interrupt — when the dispatch seam built an interrupt router for
   *  a `block` tool (knob ON), it threads the derived suppressible signal + the
   *  critical-section seam here. ABSENT ⇒ the ctx uses the raw `config.signal`
   *  and carries NO `criticalSection` (byte-identical: a `block` tool behaves
   *  like `cancel`). */
  interrupt?: { signal: AbortSignal; criticalSection: ToolContext["criticalSection"] }
}): ToolContext => {
  const { config, workingState, collabMode, toolCallId, interrupt } = args
  const requestPlanExit = buildRequestPlanExit(config, collabMode)
  const enterPlanMode = buildEnterPlanMode(config)
  const reviewerAgent = materializeReviewerAgent(config)
  return {
    cwd: config.cwd,
    // jun-6 — a `block` tool (knob ON) runs over the DERIVED suppressible signal
    // so its critical section can withhold an in-flight ESC; otherwise the raw
    // upstream signal (byte-identical legacy).
    signal: interrupt?.signal ?? config.signal,
    ...(interrupt?.criticalSection !== undefined
      ? { criticalSection: interrupt.criticalSection }
      : {}),
    gitWriteGuard: gitWriteProtectReason,
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
    // ADR-0416 sibling-identity fix — surface the STABLE per-agent mailbox
    // label (and the parent's) so the subagent-mailbox tools address each
    // sibling uniquely. ABSENT (root session / legacy caller) ⇒ omitted ⇒ the
    // tools fall back to the depth-derived label (byte-identical). Extracted to
    // a helper so this builder stays under the biome cognitive-complexity cap.
    ...mailboxLabels(config),
    ...buildSessionSeams({ config, workingState, requestPlanExit, enterPlanMode, reviewerAgent }),
    ...buildEditSeams(config),
    ...buildObserverSeams(config, toolCallId),
    ...buildCodeAndWorkspaceSeams(config, toolCallId),
  }
}
