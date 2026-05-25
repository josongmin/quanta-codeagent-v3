import type { AgentConfig, AgentOutcome } from "@/agent"
import { startAutomationEngineTicker } from "@/agent/loop-helpers"
import type { Message } from "@/llm"
import { injectSimulatedTurn, type LastTurnOutcome, REACTOR_ENV_FLAG } from "@/reactor"
import { assembleAutomation } from "@/scheduler/runtime-wire"
import { type RunInteractiveInput, runInteractive, runOnce } from "@/runner"
import { logger } from "@/shared"
import type { PlaybookPlanQueueSink } from "@/skill/playbook"
import { automationUpdateTool, ToolRegistry } from "@/tool"
import { assembleConfig } from "../internal"
import { startReactorWatchBridge } from "../reactor-watch-bridge"
import type { ConvCheckpointWire } from "./conv-checkpoint-wire"
import { ExternalPromptQueue } from "./external-prompt-queue"
import type { PlaybookTriggerSurfaceSeam } from "./playbook-trigger-surface-seam"
import {
  maybeStartPlaybookTriggerWire,
  type PlaybookTriggerWireHandle,
} from "./playbook-trigger-wire"
import { composePromptPipeline, type DispatchSlash } from "./prompt-pipeline"
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
  /** Optional text inbox the prompt pipeline drains per turn (ADR-0291).
   *  When present + non-empty, the drained entries are prepended to the
   *  user's literal text in the very next turn. Absent ⇒ pipeline behaves
   *  byte-identically (no drain, no preamble). */
  readonly textInbox?: import("../text-inbox").TextInbox
  /** Optional once-only `process.once('exit', ...)` registrar — keeps the
   *  loop from coupling to the process module directly so tests can stub it. */
  readonly registerExitTeardown?: (cb: () => void) => void
  /** ADR-0292 — turn-end auto-record wire. When present, the loop calls
   *  `recordTurn(messages)` after each successful turn completion (post-
   *  final-LLM-text, pre-next-prompt). Absent ⇒ no record, no allocation
   *  beyond the dep slot (default-OFF byte-identical). */
  readonly convCheckpointWire?: ConvCheckpointWire | null
  /** ADR-0292 — surface-side hook the loop registers so `/rewind-conv <tag>`
   *  can mutate the live `history` binding. Called once before the
   *  interactive driver starts. Absent ⇒ `/rewind-conv` restore still
   *  succeeds against the store but the surface transcript stays stale. */
  readonly registerReplaceMessages?: (fn: (msgs: ReadonlyArray<Message>) => void) => void
  /** ADR-0293 — playbook-trigger seam the loop attaches to once it owns the
   *  `ExternalPromptQueue` (the queue is the sink target). Absent ⇒ no
   *  trigger wire is constructed (default-OFF byte-identical). */
  readonly playbookSeam?: PlaybookTriggerSurfaceSeam
  /** ADR-0293 — operator-supplied CLI flag echo. The same env precedence
   *  (`QUANTA_PLAYBOOK_TRIGGER=on` wins over flag=false) is enforced
   *  inside `maybeStartPlaybookTriggerWire`. */
  readonly playbookCliFlag?: boolean
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
  const {
    setup,
    dispatchSlash,
    sinks,
    ux,
    imageQueue,
    textInbox,
    registerExitTeardown,
    convCheckpointWire,
    registerReplaceMessages,
    playbookSeam,
    playbookCliFlag,
  } = deps
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
  const liveAutomationSlot =
    sessionDeps.automationEngine ??
    assembleAutomation(
      { get: (name) => process.env[name] },
      {
        agentLoop: {
          enqueueUserMessage: async (message) => {
            externalPromptQueue.push(message)
          },
        },
      },
    ) ??
    undefined
  const activeSessionDeps =
    liveAutomationSlot !== undefined
      ? {
          ...sessionDeps,
          automationEngine: liveAutomationSlot,
          registry: sessionDeps.registry.has("automation_update")
            ? sessionDeps.registry
            : new ToolRegistry([
                ...sessionDeps.registry.all(),
                automationUpdateTool(liveAutomationSlot.engine),
              ]),
        }
      : sessionDeps

  // ADR-0292 — install the `/rewind-conv` swap closure so the slash can mutate
  // the live history binding the loop reads each turn. No-throw on the swap;
  // a failure surfaces via logger.warn (already wrapped in the surface-compose
  // adapter — this is the inner closure the adapter delegates to).
  if (registerReplaceMessages !== undefined) {
    registerReplaceMessages((msgs: ReadonlyArray<Message>): void => {
      surfaceState = updateSessionState(surfaceState, { history: [...msgs] })
    })
  }

  // ADR-0292 — turn-end record helper. No-op when the wire is null/absent so
  // the legacy code path is byte-identical (RFC §1.2). Defensive try/catch so
  // a misbehaving store NEVER bubbles into the loop.
  const recordTurnSnapshot = (msgs: readonly Message[]): void => {
    if (convCheckpointWire === undefined || convCheckpointWire === null) return
    try {
      convCheckpointWire.recordTurn(msgs)
    } catch (e) {
      logger.warn(`conv-checkpoint recordTurn threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ADR-0293 — playbook trigger lifecycle attach. The wire helper itself
  // implements the env/flag precedence + NOOP-handle short-circuit, so we
  // can call it unconditionally; only an active opt-in actually allocates
  // a watcher. Attach to the seam so /session finalize → seam.detach()
  // stops the handle even on abnormal shutdown.
  let playbookHandle: PlaybookTriggerWireHandle | undefined
  if (playbookSeam !== undefined) {
    const playbookSink: PlaybookPlanQueueSink = {
      enqueue: (input) => {
        try {
          externalPromptQueue.push(input.text)
          return { ok: true }
        } catch (e) {
          return {
            ok: false,
            reason: e instanceof Error ? e.message : String(e),
          }
        }
      },
    }
    playbookHandle = maybeStartPlaybookTriggerWire({
      env: process.env,
      ...(playbookCliFlag !== undefined ? { cliFlag: playbookCliFlag } : {}),
      threadId: setup.sessionId,
      planQueueSink: playbookSink,
    })
    playbookSeam.attach(playbookHandle)
  }

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
          const turnDeps = { ...activeSessionDeps, signal: turnSignal }
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
          // ADR-0292 — turn-end snapshot. No-op when the wire is null.
          recordTurnSnapshot(result.messages)
        },
        onError: sinks.renderTurnError,
      },
    )
    // ADR-0293 — even on one-shot exit, stop the playbook handle so a stray
    // watcher does not outlive the process. seam.detach() stops the handle
    // and clears the slot in one call.
    playbookSeam?.detach()
    return
  }

  // Interactive dispatch: pills dispose first so a late paint cannot
  // resurrect a stale row AFTER the scroll region is reset.
  registerExitTeardown?.(() => {
    pills.dispose()
    statusBar.teardown()
  })

  const automationTicker =
    liveAutomationSlot !== undefined
      ? startAutomationEngineTicker({ automationEngine: liveAutomationSlot } as AgentConfig)
      : undefined

  // Initial blank row matches the prior `runReplLoopRaw` header write so
  // the very first composer row sits one line below the resume log.
  process.stderr.write("\n")

  const promptSource = composePromptPipeline({
    dispatchSlash,
    externalPromptQueue,
    ...(imageQueue !== undefined ? { imageQueue } : {}),
    ...(textInbox !== undefined ? { textInbox } : {}),
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
        body: async (turnSignal) => run({ ...activeSessionDeps, signal: turnSignal }),
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
      deps: activeSessionDeps,
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
        // ADR-0292 — record AFTER the state swap so the snapshot reflects
        // the exact history binding the next turn will see.
        recordTurnSnapshot(messages)
      },
    })
  } finally {
    automationTicker?.stop()
    await reactorBridge?.close()
    // ADR-0293 — lifecycle detach (stops handle + clears the seam slot
    // even on abnormal shutdown). Idempotent.
    playbookSeam?.detach()
  }
}
