import type { AgentOutcome } from "@/agent"
import type { Message } from "@/llm"
import {
  type LastTurnOutcome,
  injectSimulatedTurn,
  REACTOR_ENV_FLAG,
} from "@/reactor"
import { type RunInteractiveInput, runInteractive, runOnce } from "@/runner"
import { startReactorWatchBridge } from "../reactor-watch-bridge"
import { assembleConfig } from "../internal"
import { composePromptPipeline, type DispatchSlash } from "./prompt-pipeline"
import { ExternalPromptQueue } from "./external-prompt-queue"
import type { SessionSetupResult } from "./session-setup"
import { type SessionState, updateSessionState } from "./session-state"
import { runOneTurn } from "./turn-runner"

/** Slice-C: per-turn render + state side-effects the surface owns. Each
 *  callback is injected so the loop module is pure (no metrics / costPanel
 *  imports beyond the typed slots above). The host wires the actual
 *  metrics snapshot fold + lifecycle pills flush. */
export interface SessionLoopSinks {
  /** Render the per-turn cost+cache dashboard (default-OFF when metrics
   *  are disabled — the sink should short-circuit). */
  readonly renderTurnDashboard: () => void
  /** Fold the per-turn token delta into the cost panel + render the
   *  turn-summary panel + reset the summary collector. */
  readonly renderAndResetSummary: (outcome: { messages: readonly Message[] }) => void
  /** Snapshot the lifecycle pills (subagent / follow-up / mcp) + flush. */
  readonly flushLifecyclePills: () => void
  /** Render a NON-abort turn-level error inline + on the status bar. */
  readonly renderTurnError: (err: unknown) => void
}

/** Dependencies for {@link runSessionLoop}. Every dep is EXPLICIT so the
 *  loop owns ZERO closure captures over the surface state. */
export interface RunSessionLoopDeps {
  readonly setup: SessionSetupResult
  /** Slash dispatcher the prompt pipeline calls on every `/<cmd>` line.
   *  Returns true iff the input was routed (loop `continue`s); false ⇒
   *  forward as the next model prompt. */
  readonly dispatchSlash: DispatchSlash
  /** Per-turn renderers + side-effects. */
  readonly sinks: SessionLoopSinks
  /** Optional UX hooks (history-file / multiline). */
  readonly ux?: {
    readonly promptHistory?: import("../prompt-history").PromptHistory
    readonly multiline?: boolean
  }
  /** Optional image queue the prompt pipeline drains per turn. */
  readonly imageQueue?: import("../image-queue").ImageQueue
  /** Optional once-only `process.once('exit', ...)` registrar — keeps the
   *  loop from coupling to the process module directly so tests can stub it. */
  readonly registerExitTeardown?: (cb: () => void) => void
}

/** Default Esc-Esc cancel window (ms). Matches the prior inline constant in
 *  `runRepl.installTurnCancel`. Held as a module constant so the runner +
 *  the wrapTurn share ONE value (the prior code duplicated `ESC_WINDOW_MS`
 *  across both call sites). */
const ESC_WINDOW_MS = 2000

const mapAgentOutcomeToReactorOutcome = (outcome: AgentOutcome): LastTurnOutcome => {
  switch (outcome.reason) {
    case "completed":
      return "success"
    case "max_turns":
    case "aborted":
    case "budget_exhausted":
      return "partial"
    case "error":
    case "refusal":
      return "fail"
  }
}

/** Run the per-session orchestration: ONE-shot when `setup.argPrompt`
 *  is set, INTERACTIVE otherwise. Both paths funnel each turn through
 *  {@link runOneTurn} so the per-turn wrapper (turn-abort install +
 *  indicator + cost+summary) is identical across the two branches —
 *  the DRY win the SOLID split targets. */
export const runSessionLoop = async (deps: RunSessionLoopDeps): Promise<void> => {
  const { setup, dispatchSlash, sinks, ux, imageQueue, registerExitTeardown } = deps
  const {
    abort,
    statusBar,
    turnIndicator,
    turnSummary,
    sessionDeps,
    state: featureState,
    idMeta,
    pendingImages,
    history,
    pills,
  } = setup

  // Slice-C: 5 god-state `let`s collapsed into ONE SessionState record.
  let surfaceState: SessionState = {
    cwd: setup.cwd,
    llm: setup.llm,
    sessionId: setup.sessionId,
    pendingImages,
    history,
  }
  const externalPromptQueue = new ExternalPromptQueue()
  let lastUserInputAt = 0
  let lastTurnOutcome: LastTurnOutcome | undefined

  // One-shot dispatch: drive a SINGLE turn through `runOneTurn` then return.
  if (setup.argPrompt) {
    await runOneTurn<Awaited<ReturnType<typeof runOnce>>>(
      {
        outerAbort: abort,
        statusBar,
        turnIndicator,
        turnSummary,
        escWindowMs: ESC_WINDOW_MS,
        body: async (turnSignal) => {
          // ADR-0083: attach seed images to the FIRST turn only, then drain
          // so subsequent runs are text-only (byte-identical when no --image).
          const seedImages = surfaceState.pendingImages
          surfaceState = updateSessionState(surfaceState, { pendingImages: [] })
          const turnDeps = { ...sessionDeps, signal: turnSignal }
          return runOnce({
            deps: turnDeps,
            assembleConfig,
            history: [...surfaceState.history],
            prompt: setup.argPrompt as string,
            pendingImages: [...seedImages],
            state: featureState,
            idMeta,
          })
        },
      },
      {
        onAfterResult: (result) => {
          surfaceState = updateSessionState(surfaceState, { history: result.messages })
          // The host-injected `renderTurnDashboard` sink does the metrics
          // snapshot fold + dashboard write + cost-panel fold internally
          // (host wires it to the SAME inline code the prior `turn` closure
          // ran). One-shot AND interactive funnel through this single sink
          // so the per-turn render is byte-identical across both paths.
          sinks.renderTurnDashboard()
          sinks.renderAndResetSummary(result)
          sinks.flushLifecyclePills()
        },
        onError: sinks.renderTurnError,
      },
    )
    return
  }

  // Interactive dispatch: pills dispose first so a late paint cannot
  // resurrect a stale row AFTER the scroll region is reset.
  registerExitTeardown?.(() => {
    pills.dispose()
    statusBar.teardown()
  })

  // Initial blank row matches the prior `runReplLoopRaw` header write so
  // the very first composer row sits one line below the resume log.
  process.stderr.write("\n")

  const promptSource = composePromptPipeline({
    dispatchSlash,
    externalPromptQueue,
    ...(imageQueue !== undefined ? { imageQueue } : {}),
    idleMonitor: setup.idleMonitor,
    onLocalPromptAccepted: () => {
      lastUserInputAt = Date.now()
    },
    rejectCounter: setup.rejectCounter,
    statusBar,
    ...(ux !== undefined ? { ux } : {}),
  })

  const reactorBridge =
    setup.sessionId !== undefined && process.env[REACTOR_ENV_FLAG] === "1"
      ? await startReactorWatchBridge({
          sessionId: setup.sessionId,
          onTrigger: async (trigger) => {
            await injectSimulatedTurn({
              trigger,
              agentLoop: {
                enqueueUserMessage: async (message) => {
                  externalPromptQueue.push(message)
                },
              },
              envPort: { get: (name) => process.env[name] },
              clockPort: { now: () => Date.now() },
              lastUserInputAt,
              ...(lastTurnOutcome !== undefined ? { lastTurnOutcome } : {}),
            })
          },
          onError: (message) => {
            process.stderr.write(`${message}\n`)
          },
        })
      : undefined

  type WrapTurn = NonNullable<RunInteractiveInput["wrapTurn"]>
  const wrapTurn: WrapTurn = async (run) => {
    const out = await runOneTurn(
      {
        outerAbort: abort,
        statusBar,
        turnIndicator,
        turnSummary,
        escWindowMs: ESC_WINDOW_MS,
        body: async (turnSignal) => run({ ...sessionDeps, signal: turnSignal }),
      },
      {
        onAfterResult: (result) => {
          sinks.renderTurnDashboard()
          sinks.renderAndResetSummary(result)
        },
        onError: sinks.renderTurnError,
      },
    )
    process.stderr.write("\n")
    if (out.turnAborted) {
      lastTurnOutcome = "fail"
      return { cancelled: true }
    }
    if (out.result === undefined) {
      lastTurnOutcome = "fail"
      return undefined
    }
    lastTurnOutcome = mapAgentOutcomeToReactorOutcome(out.result.outcome)
    return out.result
  }
  try {
    await runInteractive({
      deps: sessionDeps,
      assembleConfig,
      promptSource,
      history: [...surfaceState.history] as Message[],
      state: featureState,
      idMeta,
      signal: abort.signal,
      seedImages: [...surfaceState.pendingImages],
      wrapTurn,
      onTurnEnd: ({ outcome, messages }) => {
        lastTurnOutcome = mapAgentOutcomeToReactorOutcome(outcome)
        surfaceState = updateSessionState(surfaceState, { history: messages })
        sinks.flushLifecyclePills()
      },
    })
  } finally {
    await reactorBridge?.close()
  }
}
