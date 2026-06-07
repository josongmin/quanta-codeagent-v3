import type { Message } from "@/llm"
import type { TurnTiming } from "@/observability"
import { getBashBgRegistry } from "@/runtime/bash-bg-registry"
import type { RedactionHit, RedactionOrigin } from "@/security"
import { errMessage } from "@/shared"
import {
  cancelSubagent,
  isCancelSubagentOp,
  isInterruptOp,
  isSetModeOp,
} from "../control-op-handler"
import type { buildSessionFeatures } from "../features"
import { scanEnvelopeForRedactions } from "../loop-helpers"
import { persistSession } from "../memory"
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

export const cleanupFinishedSession = async (args: {
  readonly cfg: AgentConfig
  readonly features: Awaited<ReturnType<typeof buildSessionFeatures>>
}): Promise<void> => {
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
  // M1 leak fix (jun-7) — reap this process's background bash shells on session
  // end. A `timeout_behavior:"background"` command registers a DETACHED shell
  // (`bash -lc "npm run dev"` + its tree) that outlives the turn; without this
  // the registry holds it for the whole process lifetime. No-throw wrapped like
  // the sibling disposals above.
  try {
    await getBashBgRegistry().killAll()
  } catch (e) {
    args.cfg.stream.emit({ type: "error", message: `bg-shell reap failed: ${errMessage(e)}` })
  }
  await saveFollowUpQueueSnapshot(args.cfg)
  await savePlanSnapshot(args.cfg)
  // Leak fix (jun-7) — drop this session's microcompact-cadence map entry so the
  // module Map in `compaction-wire` doesn't grow one entry per session forever.
  forgetMicrocompactSession(args.cfg.sessionId)
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
  await cleanupFinishedSession({ cfg: args.cfg, features: args.features })
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

export const runSessionStartSequence = async (args: {
  readonly cfg: AgentConfig
  readonly wm: import("@/memory").WorkingMemory<Message>
  readonly sessionId: string
  readonly taskRegistry: { forceStop(id: string): boolean } | undefined
}): Promise<"continue" | "aborted"> => {
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
    if (denied !== null) return "aborted"
  }
  observeEffortClassifierPrompt(args.cfg.effortClassifier, latestUserTextFromWm(args.wm))
  await restoreFollowUpQueueSnapshot(args.cfg)
  await restorePlanSnapshot(args.cfg)
  return handleSubmissionControlOp(args.cfg, args.taskRegistry) === "aborted"
    ? "aborted"
    : "continue"
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
    const from: "default" | "plan" =
      cfg.mode === "plan" || cfg.planMode === true ? "plan" : "default"
    const to = cfg.submission.op.mode
    if (from !== to) {
      const reason = cfg.submission.op.reason
      cfg.stream.emit({
        type: "mode_changed",
        from,
        to,
        ...(reason !== undefined ? { reason } : {}),
      })
    }
  }
  return "continue"
}
