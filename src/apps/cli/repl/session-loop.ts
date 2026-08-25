import type { LastTurnOutcome } from "@/reactor"
import { stripAutomationTickerHandler } from "./session-loop/automation"
import { bootstrapSessionLoop } from "./session-loop/bootstrap"
import type { RunSessionLoopDeps } from "./session-loop/deps"
import { runInteractiveBranch } from "./session-loop/interactive-branch"
import { runOneShotBranch } from "./session-loop/one-shot-branch"
import { shouldWireBackground } from "./session-loop/turn-helpers"
import type { SessionState } from "./session-state"

export type { RunSessionLoopDeps } from "./session-loop/deps"
export type { SessionLoopSinks } from "./session-loop/types"
// Re-export the complete prior public surface so every importer of
// `./session-loop` stays byte-compatible (`shouldWireBackground` +
// `stripAutomationTickerHandler` are public exports consumed by the
// background-ctrlb / automation-single-owner hellgate tests).
export { shouldWireBackground, stripAutomationTickerHandler }

/** Run the per-session orchestration: ONE-shot when `setup.argPrompt` is set,
 *  INTERACTIVE otherwise. Both paths funnel each turn through {@link runOneTurn}
 *  so the per-turn wrapper (turn-abort install + indicator + cost+summary) is
 *  identical across the two branches — the DRY win the SOLID split targets.
 *
 *  The 300-line pre-branch wiring cluster now lives in `bootstrapSessionLoop`;
 *  the per-branch bodies live in `one-shot-branch` / `interactive-branch`. This
 *  entrypoint owns ONLY the shared mutable `let` bindings (threaded through the
 *  helpers via explicit getters/setters so their reassignments are byte-
 *  identical to the prior in-scope ones) and the branch selection. */
export const runSessionLoop = async (deps: RunSessionLoopDeps): Promise<void> => {
  const { setup, sinks, convCheckpointWire, notify, notifyCwdBasename } = deps
  const { pendingImages, history, pills, statusBar } = setup

  // Slice-C: 5 god-state `let`s collapsed into ONE SessionState record, held in
  // a mutable holder so the extracted wires reassign the SAME binding.
  const stateHolder: { surfaceState: SessionState } = {
    surfaceState: {
      cwd: setup.cwd,
      llm: setup.llm,
      sessionId: setup.sessionId,
      pendingImages,
      history,
    },
  }
  let lastUserInputAt = 0
  let lastTurnOutcome: LastTurnOutcome | undefined

  const boot = await bootstrapSessionLoop(deps, stateHolder)

  const getSurfaceState = (): SessionState => stateHolder.surfaceState
  const setSurfaceState = (next: SessionState): void => {
    stateHolder.surfaceState = next
  }
  const setLastTurnOutcome = (outcome: LastTurnOutcome): void => {
    lastTurnOutcome = outcome
  }

  // One-shot dispatch: drive a SINGLE turn through `runOneTurn` then return.
  if (setup.argPrompt) {
    await runOneShotBranch({
      setup,
      sinks,
      withInTurnCapture: boot.withInTurnCapture,
      runSessionTurn: boot.runSessionTurn,
      externalPromptQueue: boot.externalPromptQueue,
      convCheckpointWire,
      notify,
      notifyCwdBasename,
      drainCloseStack: boot.drainCloseStack,
      getSurfaceState,
      setSurfaceState,
      setLastTurnOutcome,
    })
    return
  }

  // Interactive dispatch: pills dispose first so a late paint cannot resurrect a
  // stale row AFTER the scroll region is reset.
  deps.registerExitTeardown?.(() => {
    pills.dispose()
    statusBar.teardown()
  })

  await runInteractiveBranch({
    setup,
    sinks,
    withInTurnCapture: boot.withInTurnCapture,
    runSessionTurn: boot.runSessionTurn,
    externalPromptQueue: boot.externalPromptQueue,
    convCheckpointWire,
    notify,
    notifyCwdBasename,
    drainCloseStack: boot.drainCloseStack,
    closeStack: boot.closeStack,
    backgroundPortal: deps.backgroundPortal,
    inboundMode: deps.inboundMode,
    conversationActions: deps.conversationActions,
    liveAutomationSlot: boot.liveAutomationSlot,
    dispatchSlash: deps.dispatchSlash,
    imageQueue: deps.imageQueue,
    textInbox: deps.textInbox,
    ux: deps.ux,
    contextWarning: deps.contextWarning,
    objectiveStore: deps.objectiveStore,
    goalWakeSlot: deps.goalWakeSlot,
    activeTurnRef: deps.runtimeFacadeCompose?.activeTurnRef,
    activeIdentityModeState: boot.activeIdentityModeState,
    enqueueWithHeartbeat: boot.enqueueWithHeartbeat,
    getSurfaceState,
    setSurfaceState,
    setLastTurnOutcome,
    getLastTurnOutcome: () => lastTurnOutcome,
    getLastUserInputAt: () => lastUserInputAt,
    setLastUserInputAt: (at) => {
      lastUserInputAt = at
    },
  })
}
