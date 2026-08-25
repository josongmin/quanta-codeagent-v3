import type { InteractiveBranchCtx } from "./branch-context"
import { runInteractiveLoop } from "./interactive-loop"
import { wireInteractiveSetup } from "./interactive-setup"
import { warnLiveBackgroundTurns } from "./turn-helpers"

/** Interactive dispatch: build the interactive wiring, run the input/turn loop,
 *  print the resume link on clean exit — all inside ONE try/finally so a throw
 *  during any awaited setup step still drains the close stack (no leaked facade
 *  / session / watcher / ticker / bridge on partial init). Extracted verbatim
 *  from `runSessionLoop`; the try/finally boundary, the `warnLiveBackgroundTurns`
 *  + `drainCloseStack` teardown order, and the resume-link gate are unchanged. */
export const runInteractiveBranch = async (ctx: InteractiveBranchCtx): Promise<void> => {
  const {
    setup,
    closeStack,
    liveAutomationSlot,
    dispatchSlash,
    externalPromptQueue,
    imageQueue,
    textInbox,
    ux,
    notify,
    notifyCwdBasename,
    contextWarning,
    objectiveStore,
    goalWakeSlot,
    activeTurnRef,
    activeIdentityModeState,
    planQueueStore,
    enqueueWithHeartbeat,
    getLastTurnOutcome,
    getLastUserInputAt,
    setLastUserInputAt,
    backgroundPortal,
    drainCloseStack,
  } = ctx
  // L5 H-7 — the interactive SETUP (automation ticker / reactor bridge /
  // prompt pipeline) plus the run loop live inside ONE try/finally so a throw
  // during any awaited setup step still drains the close stack (no leaked
  // facade / session / watcher / ticker / bridge on partial init).
  try {
    const wiring = await wireInteractiveSetup({
      setup,
      closeStack,
      liveAutomationSlot,
      dispatchSlash,
      externalPromptQueue,
      imageQueue,
      textInbox,
      ux,
      notify,
      notifyCwdBasename,
      contextWarning,
      objectiveStore,
      goalWakeSlot,
      activeTurnRef,
      activeIdentityModeState,
      planQueueStore,
      currentThreadId: () => ctx.getSurfaceState().sessionId,
      enqueueWithHeartbeat,
      getLastTurnOutcome,
      getLastUserInputAt,
      setLastUserInputAt,
    })
    await runInteractiveLoop(ctx, wiring)
    // Print resume link after clean /exit so the user can continue later.
    if (setup.stderrIsTTY === true && setup.idMeta !== undefined) {
      process.stderr.write(`\x1b[2mResume: quanta --resume ${setup.idMeta.id}\x1b[0m\n`)
    }
  } finally {
    // WS-H / UUX-3-12 — REPL-exit honesty: if backgrounded turns are still
    // running, say so (one warning line, id + label) instead of silently
    // abandoning them. No-throw; silent when the portal is absent/idle.
    warnLiveBackgroundTurns(backgroundPortal, (s) => process.stderr.write(s))
    // L5 H-7 — single teardown authority. LIFO drain stops background
    // producers (reactor bridge, automation ticker) and the playbook watcher
    // BEFORE closing the session + runtimeFacade, matching the prior manual
    // order, and runs even on abnormal shutdown. Idempotent.
    await drainCloseStack()
  }
}
