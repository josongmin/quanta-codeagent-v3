import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import { errMessage } from "@/shared"
import { captureInterruptedTurn } from "../interrupted-turn"
import { stampTurn } from "../session-resources"
import type { ShellSnapshotSession } from "../shell-snapshot-session"
import { makeTurnHeader } from "../turn-kind"
import type { AgentConfig } from "../types"
import { compactNowOnDemand } from "./compaction-wire"
import { latestUserTextFromWm, observeEffortClassifierPrompt } from "./context-assembler"
import { pollConversationAction, pollFollowUpQueue, pollPeerInbox } from "./control-poll"

export const applySteerBarrierMessages = async (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
): Promise<void> => {
  if (!cfg.steerBarrier) return
  const beforeLen = cfg.messages.length
  await cfg.steerBarrier()
  for (let i = beforeLen; i < cfg.messages.length; i++) {
    const injected = cfg.messages[i]
    if (injected) wm.append(injected)
  }
}

export const setActiveTurnHeader = (cfg: AgentConfig, sessionId: string): void => {
  if (!cfg.activeTurnRef) return
  cfg.activeTurnRef.current = {
    currentTurn: makeTurnHeader({
      turnId: crypto.randomUUID(),
      kind: "main",
      startedAt: Date.now(),
      threadId: sessionId,
    }),
    isInterrupted: false,
  }
}

export const syncQueuedTurnInputs = async (args: {
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly taskRegistry: { forceStop(id: string): boolean } | undefined
}): Promise<"continue" | "aborted"> => {
  const followUpResult = pollFollowUpQueue(args.cfg, args.sessionId)
  if (followUpResult !== null) args.wm.append(followUpResult)
  // Peer teammate messaging (RFC jun-6, DELTA #1) — auto-deliver this agent's
  // undelivered peer mail into the turn (no manual `subagent_read_messages`).
  // INFORMATION-only: it never invokes the permission decider (no-grant-channel).
  // Default-OFF: `pollPeerInbox` returns null when no port is wired ⇒ this seam
  // is byte-identical (one extra null-returning call, no `wm` append).
  const peerMail = pollPeerInbox(args.cfg)
  if (peerMail !== null) args.wm.append(peerMail)
  const actionOutcome = await pollConversationAction(args.cfg, args.taskRegistry)
  if (actionOutcome.kind === "finish_aborted") {
    // §11.5 — capture the partial turn into the session buffer so a later
    // `resume` can restore it. Default-OFF: no buffer wired ⇒ no capture
    // (byte-identical). The buffer's presence is the resumable-interrupt signal.
    args.cfg.interruptedTurnBuffer?.capture(
      captureInterruptedTurn(args.wm.snapshot(), actionOutcome.reason, Date.now()),
    )
    return "aborted"
  }
  if (actionOutcome.kind === "injection") {
    args.wm.append(actionOutcome.message)
    observeEffortClassifierPrompt(args.cfg.effortClassifier, latestUserTextFromWm(args.wm))
  }
  if (actionOutcome.kind === "summarize") {
    // §11.5 — the `/summarize-now` verb: run an on-demand force-compaction over
    // working memory. No-op when `config.compaction` is absent (degrades clean).
    await compactNowOnDemand(args.cfg, args.wm)
  }
  return "continue"
}

export const injectFocusChainMessage = (cfg: AgentConfig, wm: WorkingMemory<Message>): void => {
  if (cfg.focusChain === undefined) return
  try {
    cfg.focusChain.tracker.tickTurn()
    const injection = cfg.focusChain.tracker.getInjection()
    if (injection !== null && injection.trim().length > 0) {
      wm.append({
        role: "user",
        content: [{ type: "text", text: injection }],
      })
    }
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `focus-chain inject failed: ${errMessage(e)}`,
    })
  }
}

export const prepareTurnIteration = async (args: {
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly taskRegistry: { forceStop(id: string): boolean } | undefined
  readonly turn: number
  readonly localizePhaseState: import("../localize-phase-guard").LocalizePhaseState | undefined
  readonly dedupGate: unknown
  readonly shellSnapshotSession: ShellSnapshotSession | undefined
  readonly hookPromptPending: import("../hooks").HookPromptInject[]
}): Promise<"continue" | "aborted"> => {
  if (args.cfg.signal.aborted) return "aborted"
  if (args.localizePhaseState !== undefined) args.localizePhaseState.turn = args.turn - 1
  args.cfg.budgetMeter?.tick("turn")
  await applySteerBarrierMessages(args.cfg, args.wm)
  setActiveTurnHeader(args.cfg, args.sessionId)
  const queuedInputs = await syncQueuedTurnInputs(args)
  if (queuedInputs === "aborted") return "aborted"
  injectFocusChainMessage(args.cfg, args.wm)
  if (args.dedupGate) {
    const stamped = stampTurn(args.cfg.run, args.turn)
    args.cfg.run = stamped ?? { runId: args.sessionId, turn: args.turn }
  }
  if (args.shellSnapshotSession !== undefined) {
    await args.shellSnapshotSession.snapshotForTurn(args.turn)
  }
  args.cfg.stream.emit({ type: "turn_start", turn: args.turn })
  if (args.cfg.hooks) {
    const turnStart = await args.cfg.hooks.emit({ type: "turn_start", turn: args.turn })
    if (turnStart.promptHook !== undefined) args.hookPromptPending.push(turnStart.promptHook)
  }
  return "continue"
}
