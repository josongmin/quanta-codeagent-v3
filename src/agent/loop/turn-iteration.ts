import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import { costUsd } from "@/observability"
import { errMessage } from "@/shared"
import type { BudgetExhaustion } from "../budget"
import { estimateTokens } from "../compaction"
import { syncFocusChainFromPlan } from "../focus-chain/plan-bridge"
import { captureAbortedTurn } from "../interrupted-turn"
import { buildIdentityReminderText } from "../loop-helpers"
import { resolveAgentMode } from "../mode"
import { stampTurn } from "../session-resources"
import type { ShellSnapshotSession } from "../shell-snapshot-session"
import { makeSyntheticUserMessage } from "../synthetic-user"
import { makeTurnHeader } from "../turn-kind"
import type { AgentConfig } from "../types"
import { injectWorkflowKeywordNudge } from "../workflow-keyword"
import { compactNowOnDemand } from "./compaction-wire"
import { latestUserTextFromWm, observeEffortClassifierPrompt } from "./context-assembler"
import {
  pollControlRequests,
  pollConversationAction,
  pollFollowUpQueue,
  pollPeerInbox,
} from "./control-poll"

export const applySteerBarrierMessages = async (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
): Promise<void> => {
  if (!cfg.steerBarrier) return
  const beforeLen = cfg.messages.length
  // ALBB-20 #2 — a throwing steer barrier USED to escape uncaught and crash the
  // whole turn (`await cfg.steerBarrier()` bare). Mirror the sibling
  // `injectFocusChainMessage` emit-on-throw shape: surface the failure as a
  // non-fatal stream `error` and continue the turn (the barrier's injected
  // messages, if any, are drained on the happy path only). Parity, not a new
  // heuristic.
  try {
    await cfg.steerBarrier()
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `steer barrier failed: ${errMessage(e)}`,
    })
    return
  }
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

/** ALBB-06 — the outcome of the queued-input drain. `aborted_captured` means the
 *  drain already CAPTURED the interrupted turn (the `/cancel` finish_aborted
 *  path), so the caller must NOT re-capture (which would clobber the
 *  conversation_cancel reason with signal_abort — a double-capture). A bare
 *  `aborted` (a future signal-driven drain exit that does NOT self-capture) tells
 *  the caller to capture with the `signal_abort` reason. */
export type SyncQueuedOutcome = "continue" | "aborted" | "aborted_captured"

export const syncQueuedTurnInputs = async (args: {
  readonly cfg: AgentConfig
  readonly wm: WorkingMemory<Message>
  readonly sessionId: string
  readonly taskRegistry: { forceStop(id: string): boolean } | undefined
  // D5 (jul-2) — the per-session token-baseline box, threaded so the
  // `/summarize-now` verb (`compactNowOnDemand` below) can invalidate it after it
  // shrinks the prefix. `undefined` ⇒ no box wired ⇒ byte-identical.
  readonly tokenBaseline: import("../compaction").TokenBaselineBoxState | undefined
}): Promise<SyncQueuedOutcome> => {
  const followUpResult = pollFollowUpQueue(args.cfg, args.sessionId)
  if (followUpResult !== null) args.wm.append(followUpResult)
  // Peer teammate messaging (RFC jun-6, DELTA #1) — auto-deliver this agent's
  // undelivered peer mail into the turn (no manual `subagent_read_messages`).
  // INFORMATION-only: it never invokes the permission decider (no-grant-channel).
  // Default-OFF: `pollPeerInbox` returns null when no port is wired ⇒ this seam
  // is byte-identical (one extra null-returning call, no `wm` append).
  const peerMail = pollPeerInbox(args.cfg)
  if (peerMail !== null) args.wm.append(peerMail)
  // Control-request drain (ADR-0496, jul-03 A1) — ACTIVATES the previously-inert
  // `drainControlRequests` surface. Runtime-control (set_model / set_permission_
  // mode / set_thinking / get_context_usage) lands on the host via the wired
  // applier; it appends NOTHING to `wm` (these mutate runtime state, not the
  // transcript). Default-OFF: no slot / gate off ⇒ the port is never polled
  // (byte-identical), sibling of the peer-inbox drain above.
  pollControlRequests(args.cfg)
  const actionOutcome = await pollConversationAction(args.cfg, args.taskRegistry)
  if (actionOutcome.kind === "finish_aborted") {
    // §11.5 — capture the partial turn into the session buffer so a later
    // `resume` can restore it. Default-OFF: no buffer wired ⇒ no capture
    // (byte-identical). The buffer's presence is the resumable-interrupt signal.
    // ALBB-06: refactored onto the shared `captureAbortedTurn` helper — the
    // reason stays `actionOutcome.reason` (conversation_cancel), so this path is
    // byte-identical to the pre-ALBB-06 direct call (paired control).
    captureAbortedTurn(args.cfg, args.wm, actionOutcome.reason)
    // ALBB-06: signal the relay that THIS abort already captured (with the
    // conversation_cancel reason) so `prepareTurnIteration` does NOT re-capture
    // and clobber it with a signal_abort reason (no double-capture on /cancel).
    return "aborted_captured"
  }
  if (actionOutcome.kind === "injection") {
    args.wm.append(actionOutcome.message)
    observeEffortClassifierPrompt(args.cfg.effortClassifier, latestUserTextFromWm(args.wm))
  }
  if (actionOutcome.kind === "summarize") {
    // §11.5 — the `/summarize-now` verb: run an on-demand force-compaction over
    // working memory. No-op when `config.compaction` is absent (degrades clean).
    // Pass the token-baseline box so the shrunk prefix invalidates it (D5).
    await compactNowOnDemand(args.cfg, args.wm, args.tokenBaseline)
  }
  return "continue"
}

/** Loop-control fix (jun-25): how many trailing turns (inclusive of the last)
 *  carry the budget-tail reminder. K≈3 gives the model a short runway to land
 *  the plane without spamming every turn. Frozen — a test asserting the tail
 *  width mutates with the source rather than duplicating a magic number. */
export const TURN_BUDGET_TAIL_REMINDER_K = 3

/** Loop-control fix (jun-25, FIX-1) — the turn budget is otherwise INVISIBLE to
 *  the model: the outer loop hard-stops at `maxTurns` and nothing ever tells the
 *  model it is running out, so it gets cut off mid-exploration. This pure helper
 *  computes the one-line reminder to inject into a turn's context when it falls
 *  within the tail `turn >= maxTurns - K`, or `null` when no reminder is due.
 *
 *  Guards (byte-identical default for unbounded / interactive-unbounded modes):
 *    - `maxTurns` non-finite (Infinity / NaN) ⇒ `null` (UNBOUNDED — never warn).
 *    - `maxTurns <= 0` ⇒ `null` (degenerate; the loop body never runs).
 *    - `turn < maxTurns - K` ⇒ `null` (not yet in the tail).
 *  Does NOT change the stop itself — it only makes the limit visible so the
 *  model can finalize/commit rather than starting new exploration. */
export const turnBudgetReminderText = (
  turn: number,
  maxTurns: number,
  k: number = TURN_BUDGET_TAIL_REMINDER_K,
): string | null => {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0) return null
  if (turn < maxTurns - k) return null
  const remaining = maxTurns - turn
  if (remaining <= 0) {
    return (
      "This is your LAST turn before the turn budget ends. Provide your final " +
      "answer / commit your work now — do not start new exploration or tool calls " +
      "you cannot finish this turn."
    )
  }
  const plural = remaining === 1 ? "turn remains" : "turns remain"
  return (
    `${remaining} ${plural} before the turn budget ends — if you are close to a ` +
    "solution, finalize/commit now rather than starting new exploration."
  )
}

/** Loop-control fix (jun-25, FIX-1) — inject the turn-budget tail reminder into
 *  this turn's context as an out-of-band user message (same seam shape as
 *  {@link injectFocusChainMessage}). No-op (byte-identical) when no reminder is
 *  due (see {@link turnBudgetReminderText} guards), so unbounded modes append
 *  nothing. */
export const injectTurnBudgetReminder = (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
  turn: number,
): void => {
  const text = turnBudgetReminderText(turn, cfg.maxTurns)
  if (text === null) return
  wm.append({ role: "user", content: [{ type: "text", text }] })
}

export const injectFocusChainMessage = (cfg: AgentConfig, wm: WorkingMemory<Message>): void => {
  if (cfg.focusChain === undefined) return
  try {
    // Feed the tracker from the structured plan store (ADR-0219 missing wire).
    // Change-gated so an unchanged plan stays a no-op and the drift detector
    // keeps accumulating. Only when a planStore is wired — absent planStore ⇒
    // the bridge does NOT touch the tracker (byte-identical to the prior unfed
    // behaviour; any direct feeder is left intact).
    if (cfg.planStore !== undefined) {
      syncFocusChainFromPlan(cfg.focusChain.tracker, cfg.planStore.current())
    }
    cfg.focusChain.tracker.tickTurn()
    const injection = cfg.focusChain.tracker.getInjection()
    if (injection !== null && injection.trim().length > 0) {
      wm.append(makeSyntheticUserMessage("focus-chain", [{ type: "text", text: injection }]))
    }
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `focus-chain inject failed: ${errMessage(e)}`,
    })
  }
}

/** Per-session dedup for the identity registry-throw warn — mirror the
 *  `focus-chain inject failed` one-shot cadence so a persistently-broken
 *  registry warns ONCE per session (a `cfg` instance) rather than every turn. */
const identityRegistryThrowWarned = new WeakSet<AgentConfig>()

/** ADR-0239 §C / ALBB-14 — the FOURTH per-turn injector, sibling of
 *  {@link injectFocusChainMessage} / {@link injectWorkflowKeywordNudge} /
 *  {@link injectTurnBudgetReminder}. When the identity slot opts in
 *  (`perTurnReminderEnabled` true, or mode-conditional auto-ON for
 *  architect/editor), splice the active mode-variant's identity lines into the
 *  turn's working memory as a trailing `<system-reminder>` user message — the
 *  Codex `ARCHITECT_NOTICE` / `EDITOR_NOTICE` per-turn nudge cadence the ADR
 *  cites.
 *
 *  Default-OFF byte-identical: no `identityModeVariant` slot ⇒
 *  `buildIdentityReminderText` returns `undefined` at the first guard ⇒ nothing
 *  is appended, no allocation. The registry-throw path is now OBSERVABLE (was a
 *  silent swallow): a throwing `variantFor` emits a one-shot session-deduped
 *  error event instead of vanishing. */
export const injectIdentityReminder = (cfg: AgentConfig, wm: WorkingMemory<Message>): void => {
  const mode = resolveAgentMode(cfg.mode, cfg.planMode)
  const text = buildIdentityReminderText(cfg, mode, (e) => {
    if (identityRegistryThrowWarned.has(cfg)) return
    identityRegistryThrowWarned.add(cfg)
    cfg.stream.emit({
      type: "error",
      message: `identity per-turn reminder inject failed: ${errMessage(e)}`,
    })
  })
  if (text === undefined) return
  wm.append(makeSyntheticUserMessage("focus-chain", [{ type: "text", text }]))
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
  // D5 (jul-2) — token-baseline box forwarded to `syncQueuedTurnInputs` so
  // `/summarize-now` can invalidate it. `undefined` ⇒ byte-identical.
  readonly tokenBaseline: import("../compaction").TokenBaselineBoxState | undefined
}): Promise<"continue" | "aborted"> => {
  if (args.cfg.signal.aborted) {
    // ALBB-06 (path a) — the turn-boundary signal abort (Ctrl+C / Esc-Esc hit a
    // plain `AbortController.abort()`). Capture BEFORE the silent early return so
    // `/resume` can restore the partial work. Distinct reason for telemetry.
    // Default-OFF: no buffer wired ⇒ no-op (byte-identical).
    captureAbortedTurn(args.cfg, args.wm, "signal_abort")
    return "aborted"
  }
  if (args.localizePhaseState !== undefined) args.localizePhaseState.turn = args.turn - 1
  args.cfg.budgetMeter?.tick("turn")
  await applySteerBarrierMessages(args.cfg, args.wm)
  setActiveTurnHeader(args.cfg, args.sessionId)
  const queuedInputs = await syncQueuedTurnInputs(args)
  if (queuedInputs !== "continue") {
    // ALBB-06 (path b) — the queued-inputs relay. `aborted_captured` already
    // captured inside the drain (conversation_cancel); a bare `aborted` is a
    // signal-driven drain exit that did NOT self-capture, so we capture here with
    // the distinct signal_abort reason. Guarding on the discriminant prevents a
    // double-capture on the /cancel path. Default-OFF: no buffer ⇒ no-op.
    if (queuedInputs === "aborted") captureAbortedTurn(args.cfg, args.wm, "signal_abort")
    return "aborted"
  }
  injectFocusChainMessage(args.cfg, args.wm)
  // ADR-0239 §C / ALBB-14 — per-turn identity reminder splice (default-OFF
  // byte-identical; mode-conditional auto-ON for architect/editor). Previously
  // a DEAD WIRE: the helpers existed but no loop call site, so
  // `perTurnReminderEnabled` was inert. Sibling of the injectors around it.
  injectIdentityReminder(args.cfg, args.wm)
  // CC "ultracode" parity — a hard keyword in the user's prompt nudges this turn
  // toward `run_workflow` (only when the tool is registered; gate untouched).
  injectWorkflowKeywordNudge(args.cfg, args.wm)
  // Loop-control fix (jun-25, FIX-1) — make the approaching turn budget visible
  // to the model so it can finalize rather than be silently hard-cut at
  // `maxTurns`. No-op for unbounded `maxTurns` (byte-identical).
  injectTurnBudgetReminder(args.cfg, args.wm, args.turn)
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

/**
 * L2 pre-flight cost admission control. Returns the cost exhaustion to finish
 * on when the UPCOMING model call is GUARANTEED to breach the `maxCostUsd` cap,
 * else `undefined` (proceed). Pure / read-only — never mutates the meter.
 *
 * Projection = the prompt's INPUT-floor cost (output assumed 0). When
 * `costUsdAccum + inputFloor > cap`, the call cannot avoid breaching (output
 * only adds), so pre-empting is correct with ZERO false positives. The token
 * estimate is `estimateTokens(wm.snapshot())`, which UNDER-counts the real
 * wire prompt (it omits the system prompt + tool schemas added downstream in
 * `same-turn-engine`), making the floor strictly conservative.
 *
 * `activeModelId` MUST be the model the turn will ACTUALLY run — the caller
 * resolves it with `resolveActiveModelId` (the SAME resolver `same-turn-engine`
 * uses, so a sticky / skill model SWAP is reflected and the floor is priced at
 * the real rate). Pricing the floor at the base `config.llm` would over-estimate
 * when a skill swaps to a cheaper model and could stop a run with a large
 * fraction of budget unspent — so the resolved id is required, not optional.
 * (The effort-classifier floor only changes `thinking`, never the model, so the
 * resolved id is exact.)
 *
 * Byte-identical default-OFF: no `budgetMeter`, no `maxCostUsd` dial, or an
 * unpriced model ⇒ `undefined` (no behavior change).
 */
export const projectCostPreflight = (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
  activeModelId: string,
): BudgetExhaustion | undefined => {
  const meter = cfg.budgetMeter
  if (meter === undefined) return undefined
  const inputFloorUsd = costUsd(activeModelId, estimateTokens([...wm.snapshot()]), 0)
  if (inputFloorUsd === null) return undefined // unpriced model ⇒ no pre-flight
  const ex = meter.wouldExceedCost(inputFloorUsd)
  return ex.exhausted ? ex : undefined
}
