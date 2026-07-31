import type { Message } from "@/llm"
import type { TurnTiming } from "@/observability"
import type { RedactionHit, RedactionOrigin } from "@/security"
import { errMessage } from "@/shared"
import {
  applyBriefTransition,
  cancelSubagent,
  isCancelSubagentOp,
  isInterruptOp,
  isSetBriefOp,
  isSetModeOp,
} from "../control-op-handler"
import type { buildSessionFeatures } from "../features"
import { scanEnvelopeForRedactions } from "../loop-helpers"
import { evictLspWorkspaces } from "../lsp-bridge"
import { persistSession } from "../memory"
import { applyCollaborationModeTransition } from "../mode"
import { buildPersistDeps } from "../session-resources"
import type { StopCategory } from "../stop-category"
import type { AgentConfig, AgentOutcome, MemoryCitation, StopReason } from "../types"
import { forgetMicrocompactSession } from "./compaction-wire"
import {
  latestUserTextFromWm,
  observeEffortClassifierPrompt,
  openingTurnUserText,
} from "./context-assembler"
import { emitInterrupted, emitSubagentCancel } from "./emit-helpers"
import { emitUserPromptSubmitHook } from "./session-hooks"
import {
  restoreFollowUpQueueSnapshot,
  restorePlanSnapshot,
  saveFollowUpQueueSnapshot,
  savePlanSnapshot,
} from "./session-snapshots"

export const persistFinalMessages = async (args: {
  readonly cfg: AgentConfig
  readonly recorder: import("../metrics").AgentRecorder | undefined
  readonly redactionEnabled: boolean
  readonly recordRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void
  readonly sessionId: string
  readonly messages: readonly Message[]
  readonly reason: StopReason
}): Promise<void> => {
  if (args.redactionEnabled && args.cfg.store) {
    scanEnvelopeForRedactions(args.messages, args.recordRedaction)
  }
  if (!args.cfg.store) return
  await persistSession(
    buildPersistDeps(args.cfg, args.recorder, args.redactionEnabled, args.recordRedaction),
    {
      sessionId: args.sessionId,
      finalMessages: [...args.messages],
    },
  )
}

/** Shared once-flag so the resource-DISPOSE pass runs AT MOST once across the
 *  two callers that can reach it: the normal `finishAgentSession` chain AND the
 *  `runAgentInner` `finally` (D12 — an uncaught turn-loop throw, e.g. a mid-turn
 *  `SessionApprovalRequiredError`, must STILL dispose the resident daemons /
 *  skill-MCP / bg shells). When BOTH fire on the same session they share ONE
 *  guard so the disposers are not invoked twice. */
export interface SessionDisposeGuard {
  disposed: boolean
}

/**
 * Resource-DISPOSE half of session teardown (D12). Stops every process-lifetime
 * resource the session armed: subagent cleanup, browser, appshot, skill-MCP,
 * the resident side-agent daemons (un-unref'd wake `setInterval`s / forked
 * children), and this process's background bash shells. Each disposer is
 * no-throw wrapped so one failure never blocks the rest of the chain.
 *
 * Idempotent: when a `guard` is supplied, a second call is a no-op (the normal
 * finish path and the throw-path `finally` share one guard). Callers that omit
 * the guard rely on the disposers' own idempotence (registries only touch
 * RUNNING entries).
 */
export const disposeSessionResources = async (args: {
  readonly cfg: AgentConfig
  readonly features: Awaited<ReturnType<typeof buildSessionFeatures>>
  readonly guard?: SessionDisposeGuard
}): Promise<void> => {
  if (args.guard !== undefined) {
    if (args.guard.disposed) return
    args.guard.disposed = true
  }
  try {
    await args.features.cleanup?.()
  } catch (e) {
    const message = errMessage(e)
    args.cfg.stream.emit({ type: "error", message: `subagent cleanup failed: ${message}` })
  }
  try {
    await args.features.browserDispose?.()
  } catch (e) {
    args.cfg.stream.emit({ type: "error", message: `browser dispose failed: ${errMessage(e)}` })
  }
  try {
    await args.features.appshotDispose?.()
  } catch (e) {
    args.cfg.stream.emit({ type: "error", message: `appshot dispose failed: ${errMessage(e)}` })
  }
  try {
    await args.cfg.skillMcpSession?.shutdownAll()
  } catch (e) {
    args.cfg.stream.emit({
      type: "error",
      message: `skill-mcp shutdown failed: ${errMessage(e)}`,
    })
  }
  // Finding #7 (jun-10 silent-failure audit) — stop the resident side-agent
  // daemons on session end. `stopAll` is the registries' host-only shutdown
  // verb (deliberately NOT on the model-facing `SideAgentDaemonPort`), so
  // duck-type it off the wired registry: BOTH real backers (`@/side-agent`'s
  // in-process registry and the §4.3 process-backed one) expose it
  // structurally. Without this call the un-unref'd wake intervals keep burning
  // real LLM tokens past session end and forked children orphan under
  // QUANTA_SIDE_AGENT_PROCESS. Idempotent (both backers only touch RUNNING
  // daemons) and no-throw wrapped like the sibling disposals above.
  try {
    const daemons = args.cfg.sideAgentDaemons as
      | (NonNullable<AgentConfig["sideAgentDaemons"]> & { stopAll?: () => number })
      | undefined
    if (typeof daemons?.stopAll === "function") daemons.stopAll()
  } catch (e) {
    args.cfg.stream.emit({
      type: "error",
      message: `side-agent stopAll failed: ${errMessage(e)}`,
    })
  }
  // M1 leak fix (jun-7) — reap this process's background bash shells on session
  // end. A `timeout_behavior:"background"` command registers a DETACHED shell
  // (`bash -lc "npm run dev"` + its tree) that outlives the turn; without this
  // the registry holds it for the whole process lifetime. No-throw wrapped like
  // the sibling disposals above.
  try {
    await args.cfg.bgShellRegistry?.killAll()
  } catch (e) {
    args.cfg.stream.emit({ type: "error", message: `bg-shell reap failed: ${errMessage(e)}` })
  }
  // RFC jun-17 — evict pooled LSP workspaces on session end when the surface
  // opted in (bench). Interactive leaves them on the pool's idle-TTL for
  // cross-turn reuse; bench MUST reap so a per-instance sandbox cwd does not
  // leak a language-server child for the idle-TTL window. No-throw wrapped +
  // idempotent (evict on an absent cwd is a no-op) like the sibling disposals.
  if (args.cfg.evictLspPoolOnEnd === true) {
    try {
      await evictLspWorkspaces(args.cfg.cwd)
    } catch (e) {
      args.cfg.stream.emit({
        type: "error",
        message: `lsp workspace evict failed: ${errMessage(e)}`,
      })
    }
  }
}

/** Persist-SIDE half of session teardown — the follow-up queue / plan snapshots
 *  and the microcompact-map entry drop. Runs ONLY on a clean finish (it
 *  persists turn-derived state); the throw-path `finally` deliberately calls
 *  only {@link disposeSessionResources}. */
export const persistSessionSnapshots = async (args: {
  readonly cfg: AgentConfig
}): Promise<void> => {
  await saveFollowUpQueueSnapshot(args.cfg)
  await savePlanSnapshot(args.cfg)
  // Leak fix (jun-7) — drop this session's microcompact-cadence map entry so the
  // module Map in `compaction-wire` doesn't grow one entry per session forever.
  forgetMicrocompactSession(args.cfg.sessionId)
}

export const cleanupFinishedSession = async (args: {
  readonly cfg: AgentConfig
  readonly features: Awaited<ReturnType<typeof buildSessionFeatures>>
  readonly disposeGuard?: SessionDisposeGuard
}): Promise<void> => {
  await disposeSessionResources({
    cfg: args.cfg,
    features: args.features,
    ...(args.disposeGuard !== undefined ? { guard: args.disposeGuard } : {}),
  })
  await persistSessionSnapshots({ cfg: args.cfg })
}

export const buildFinalAgentOutcome = (args: {
  readonly reason: StopReason
  readonly turns: number
  readonly messages: readonly Message[]
  readonly stopCategory?: StopCategory
  readonly memoryCitations: readonly MemoryCitation[]
  readonly redactionAgg: ReadonlyMap<string, import("../types").RedactionRollup>
  readonly refusal?: { readonly rationale: string }
  readonly lastTurnTiming: TurnTiming | null
}): AgentOutcome => {
  const redactions = args.redactionAgg.size > 0 ? [...args.redactionAgg.values()] : undefined
  return {
    reason: args.reason,
    turns: args.turns,
    messages: [...args.messages],
    ...(args.stopCategory !== undefined ? { stopCategory: args.stopCategory } : {}),
    ...(args.memoryCitations.length > 0 ? { memoryCitations: args.memoryCitations } : {}),
    ...(redactions !== undefined ? { redactions } : {}),
    ...(args.refusal !== undefined ? { refusal: args.refusal } : {}),
    ...(args.lastTurnTiming !== null ? { turnTiming: args.lastTurnTiming } : {}),
  }
}

export const finishAgentSession = async (args: {
  readonly cfg: AgentConfig
  readonly wm: import("@/memory").WorkingMemory<Message>
  readonly sessionId: string
  readonly recorder: import("../metrics").AgentRecorder | undefined
  readonly redactionEnabled: boolean
  readonly recordRedaction: (origin: RedactionOrigin, hits: readonly RedactionHit[]) => void
  readonly features: Awaited<ReturnType<typeof buildSessionFeatures>>
  readonly memoryCitations: readonly MemoryCitation[]
  readonly redactionAgg: ReadonlyMap<string, import("../types").RedactionRollup>
  readonly lastTurnTiming: TurnTiming | null
  readonly reason: StopReason
  readonly turns: number
  readonly stopCategory?: StopCategory
  readonly refusal?: { readonly rationale: string }
  /** D12 — shared with the `runAgentInner` throw-path `finally` so the dispose
   *  pass runs at most once when both reach teardown. */
  readonly disposeGuard?: SessionDisposeGuard
}): Promise<AgentOutcome> => {
  if (args.cfg.activeTurnRef) {
    args.cfg.activeTurnRef.current = {
      currentTurn: null,
      isInterrupted: args.reason === "aborted",
    }
  }
  const messages = [...args.wm.snapshot()]
  await persistFinalMessages({
    cfg: args.cfg,
    recorder: args.recorder,
    redactionEnabled: args.redactionEnabled,
    recordRedaction: args.recordRedaction,
    sessionId: args.sessionId,
    messages,
    reason: args.reason,
  })
  await cleanupFinishedSession({
    cfg: args.cfg,
    features: args.features,
    ...(args.disposeGuard !== undefined ? { disposeGuard: args.disposeGuard } : {}),
  })
  args.recorder?.stopReason(args.reason)
  if (args.cfg.hooks) {
    await args.cfg.hooks.emit({ type: "session_end", reason: args.reason, turns: args.turns })
  }
  args.cfg.stream.emit({ type: "done", reason: args.reason, turns: args.turns })
  return buildFinalAgentOutcome({
    reason: args.reason,
    turns: args.turns,
    messages,
    memoryCitations: args.memoryCitations,
    redactionAgg: args.redactionAgg,
    lastTurnTiming: args.lastTurnTiming,
    ...(args.stopCategory !== undefined ? { stopCategory: args.stopCategory } : {}),
    ...(args.refusal !== undefined ? { refusal: args.refusal } : {}),
  })
}

/**
 * Outcome of {@link runSessionStartSequence}. `"continue"` proceeds to the turn
 * loop; the `aborted` variant carries the abort CAUSE so the caller can attribute
 * the right stop category — mirroring FIX 2c (`parkSettleFinish`), which split a
 * SYSTEM-originated interrupt (subagent-wake settle) from a genuine user Ctrl+C.
 *
 * There are exactly TWO abort causes here:
 *   - `"hook_deny"`  — a UserPromptSubmit hook DENIED the prompt: a policy /
 *                      system block, NOT a user interrupt ⇒ SYSTEM bucket.
 *   - `"interrupt"`  — an `interrupt` submission op (the genuine user interrupt)
 *                      observed by {@link handleSubmissionControlOp} ⇒ USER bucket.
 */
export type SessionStartOutcome =
  | { readonly status: "continue" }
  | { readonly status: "aborted"; readonly cause: "hook_deny" | "interrupt" }

export const runSessionStartSequence = async (args: {
  readonly cfg: AgentConfig
  readonly wm: import("@/memory").WorkingMemory<Message>
  readonly sessionId: string
  readonly taskRegistry: { forceStop(id: string): boolean } | undefined
}): Promise<SessionStartOutcome> => {
  args.cfg.stream.emit({ type: "session_start" })
  if (args.cfg.hooks) {
    await args.cfg.hooks.emit({ type: "session_start", sessionId: args.sessionId })
  }
  if (args.cfg.autoTitlePort !== undefined) {
    // ONCE-ONLY: title the session from its OPENING prompt — fire only when the
    // working memory holds exactly one user message. A resumed/continued
    // transcript (≥2 user messages) skips, so no per-turn spend.
    const firstPrompt = openingTurnUserText(args.wm)
    if (firstPrompt !== undefined && firstPrompt.trim() !== "") {
      args.cfg.autoTitlePort.maybeTitle(args.sessionId, firstPrompt)
    }
  }
  if (args.cfg.hooks !== undefined) {
    const denied = await emitUserPromptSubmitHook(args.cfg, args.wm, args.sessionId)
    // Hook DENY = policy/system block on the prompt (NOT a user Ctrl+C).
    if (denied !== null) return { status: "aborted", cause: "hook_deny" }
  }
  // `interrupt` submission op must fail-closed before snapshot restore mutates
  // any durable session state.
  if (handleSubmissionControlOp(args.cfg, args.taskRegistry) === "aborted") {
    return { status: "aborted", cause: "interrupt" }
  }
  observeEffortClassifierPrompt(args.cfg.effortClassifier, latestUserTextFromWm(args.wm))
  await restoreFollowUpQueueSnapshot(args.cfg)
  await restorePlanSnapshot(args.cfg)
  return { status: "continue" }
}

export const handleSubmissionControlOp = (
  cfg: AgentConfig,
  taskRegistry: { forceStop(id: string): boolean } | undefined,
): "aborted" | "continue" => {
  if (!cfg.submission) return "continue"
  if (isInterruptOp(cfg.submission)) {
    emitInterrupted(cfg, "submission_interrupt")
    return "aborted"
  }
  if (isCancelSubagentOp(cfg.submission)) {
    const outcome = cancelSubagent(taskRegistry, cfg.submission.op.subagentId)
    emitSubagentCancel(cfg, cfg.submission.op.subagentId, outcome, "submission_op")
  }
  if (isSetModeOp(cfg.submission)) {
    const transition = applyCollaborationModeTransition(cfg, cfg.submission.op.mode)
    if (transition.changed) {
      const reason = cfg.submission.op.reason
      cfg.stream.emit({
        type: "mode_changed",
        from: transition.from,
        to: transition.to,
        fromAgentMode: transition.fromAgentMode,
        toAgentMode: transition.toAgentMode,
        ...(reason !== undefined ? { reason } : {}),
      })
    }
  }
  // #17 (C3) — `set_brief` submission op. Routes through `applyBriefTransition`
  // (making the previously dead helper's doc TRUE) when the session has a
  // `briefStore` wired. The mutation IS the observable effect: the NEXT turn's
  // `assembleTurnContext` reads `cfg.sessionBrief()` (backed by the SAME store)
  // and splices BRIEF_NOTICE. Registry-absent ⇒ observed-and-ignored (the parent
  // turn keeps running; no throw, mirroring the cancel/mode arms).
  if (isSetBriefOp(cfg.submission) && cfg.briefStore !== undefined) {
    applyBriefTransition(cfg.briefStore, cfg.submission.op.on)
  }
  return "continue"
}
