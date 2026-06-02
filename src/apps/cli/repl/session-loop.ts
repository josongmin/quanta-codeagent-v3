import type { AgentConfig, AgentOutcome } from "@/agent"
import { startAutomationEngineTicker } from "@/agent/loop-helpers"
import type { Message } from "@/llm"
import { buildAutorunEligibility } from "@/permission"
import { injectSimulatedTurn, type LastTurnOutcome, REACTOR_ENV_FLAG } from "@/reactor"
import { assembleAutomation } from "@/scheduler/runtime-wire"
import type {
  RuntimeFacadeComposeOptions,
  RuntimeSideConversationArgs,
  RuntimeSideConversationResult,
} from "@/sdk/runtime"
import { errMessage, logger } from "@/shared"
import type { PlaybookPlanQueueSink } from "@/skill/playbook"
import { startReactorWatchBridge } from "../reactor-watch-bridge"
import type { ConvCheckpointWire } from "./conv-checkpoint-wire"
import { ExternalPromptQueue } from "./external-prompt-queue"
import type { PlaybookTriggerSurfaceSeam } from "./playbook-trigger-surface-seam"
import {
  maybeStartPlaybookTriggerWire,
  type PlaybookTriggerWireHandle,
} from "./playbook-trigger-wire"
import { composePromptPipeline, type DispatchSlash } from "./prompt-pipeline"
import { normalizeCliPromptInput } from "./prompt-types"
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
  /** Optional UX hooks (history-file / multiline / `@`-autocomplete). */
  readonly ux?: {
    readonly promptHistory?: import("../prompt-history").PromptHistory
    readonly multiline?: boolean
    readonly atProvider?: import("../at-autocomplete").AtCandidateProvider
    /** RFC-08 / ADR-0443 — turn-boundary mode store (drives the next session's
     *  permissionMode) + the derived pill meta + shift+tab hook. Absent ⇒
     *  byte-identical (permissionMode stays the runtime default). */
    readonly modeCycle?: import("../mode-cycle").ModeCycleStore
    readonly modeMeta?: string
    readonly onCycleMode?: () => { meta?: string } | undefined
    /** RFC-11 / ADR-0446 — external `$EDITOR` composition port (ctrl-x ctrl-e).
     *  Absent ⇒ byte-identical. */
    readonly openEditor?: import("../raw-line-reader-editor").ExternalEditorPort
    /** RFC-11 / ADR-0447 — loaded keybinding map (merged over defaults).
     *  Absent ⇒ byte-identical. */
    readonly keybindings?: import("../keybindings/types").KeybindingMap
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
  readonly registerReplaceMessages?: (fn: (msgs: ReadonlyArray<Message>) => Promise<void>) => void
  /** Runtime-owned `/side` starter slot. The loop installs the live session
   *  method once the runtime session exists; slash surfaces read it lazily at
   *  invocation time so they never capture a stale or pre-session closure. */
  readonly registerSideConversationStart?: (
    fn: ((args: RuntimeSideConversationArgs) => Promise<RuntimeSideConversationResult>) | undefined,
  ) => void
  /** `/queue` `sendNow` target install. The loop wires this to push the
   *  follow-up text into the live `ExternalPromptQueue` so a "send now" lands
   *  at the next turn boundary. Absent ⇒ `sendNow` reports "send-not-possible". */
  readonly registerPlanQueueSendNow?: (
    fn:
      | ((inj: { readonly text: string }) => { ok: true } | { ok: false; reason: string })
      | undefined,
  ) => void
  /** Constructor-time runtime composition payload threaded into
   *  `runtimeContext.createRuntimeFacade(...)`. Keeps the public SDK surface
   *  immutable after bootstrap while still letting the CLI supply
   *  session-owned adapters. */
  readonly runtimeFacadeCompose?: RuntimeFacadeComposeOptions
  /** ADR-0293 — playbook-trigger seam the loop attaches to once it owns the
   *  `ExternalPromptQueue` (the queue is the sink target). Absent ⇒ no
   *  trigger wire is constructed (default-OFF byte-identical). */
  readonly playbookSeam?: PlaybookTriggerSurfaceSeam
  /** ADR-0293 — operator-supplied CLI flag echo. The same env precedence
   *  (`QUANTA_PLAYBOOK_TRIGGER=on` wins over flag=false) is enforced
   *  inside `maybeStartPlaybookTriggerWire`. */
  readonly playbookCliFlag?: boolean
  /** L5 M-11 — THIS session's search-wire teardown (delta-scan `setInterval` +
   *  indexer). The host passes `boot.tooling.searchPipelineDispose` so session
   *  close releases the wire THIS session built, threaded per-session instead
   *  of via a module singleton (so two concurrent sessions each dispose their
   *  OWN wire). Absent ⇒ no wire was built (kill-switch / lexical-only);
   *  nothing is registered (default-OFF byte-identical). */
  readonly searchPipelineDispose?: () => void
  /** RFC-09 (A) — completion-notify port (ADR-0444). When present: the loop
   *  calls `onTurnComplete` after each finished turn (slow-turn gate lives in
   *  the adapter), threads it into the prompt pipeline for the idle path, and
   *  registers `dispose` on the close stack so the terminal title is restored
   *  on teardown. Absent ⇒ no notify calls, no close-stack entry
   *  (default-OFF byte-identical). */
  readonly notify?: import("../notify").NotificationPort
  /** RFC-09 (A) — short cwd label for the notify title. */
  readonly notifyCwdBasename?: string
  /** RFC-09 (B) — pre-compaction warning provider. Threaded into the prompt
   *  pipeline; a non-empty return is painted as a one-line preamble before the
   *  prompt. Absent ⇒ no preamble (default-OFF byte-identical). */
  readonly contextWarning?: () => string
}

/** Default Esc-Esc cancel window (ms). Matches the prior inline constant in
 *  `runRepl.installTurnCancel`. Held as a module constant so the runner +
 *  the wrapTurn share ONE value (the prior code duplicated `ESC_WINDOW_MS`
 *  across both call sites). */
const ESC_WINDOW_MS = 2000

/** L5 M-11 — register THIS session's search-wire teardown on the close stack
 *  when the host threaded one in (per-session, not the module singleton). Kept
 *  as a free function so the branch lives OUTSIDE `runSessionLoop` (its
 *  cognitive complexity is already at the biome cap). No-op when absent ⇒
 *  default-OFF byte-identical (kill-switch / lexical-only path; no wire built). */
const registerSearchPipelineDispose = (
  closeStack: Array<{ label: string; dispose: () => void | Promise<void> }>,
  dispose: (() => void) | undefined,
): void => {
  if (dispose === undefined) return
  closeStack.push({ label: "searchPipeline.dispose", dispose: () => dispose() })
}

/** RFC-09 (A) — register the completion-notify title restore on the close stack
 *  (LIFO; runs even on abnormal shutdown). Free function so the branch stays
 *  OUT of `runSessionLoop`'s complexity budget. No-op when the port was never
 *  built ⇒ default-OFF byte-identical. */
const registerNotifyDispose = (
  closeStack: Array<{ label: string; dispose: () => void | Promise<void> }>,
  notify: import("../notify").NotificationPort | undefined,
): void => {
  if (notify === undefined) return
  closeStack.push({ label: "notify.dispose", dispose: () => notify.dispose() })
}

/** RFC-09 (A) — fire the turn-completion notify from a finished {@link runOneTurn}
 *  result. Reuses the runner-measured `durationMs` (no new timing source); the
 *  adapter's slow-turn gate decides whether to emit. Shared by the one-shot and
 *  interactive branches. No-op when `notify` is absent ⇒ byte-identical. Free
 *  function so the call stays out of `runSessionLoop`'s complexity budget. */
const notifyTurnComplete = (
  notify: import("../notify").NotificationPort | undefined,
  out: { readonly durationMs: number; readonly result: unknown; readonly turnAborted: boolean },
  cwdBasename: string,
): void => {
  notify?.onTurnComplete({
    durationMs: out.durationMs,
    ok: out.result !== undefined && !out.turnAborted,
    cwdBasename,
  })
}

/** RFC-09 — build the optional prompt-pipeline deps (A idle notify + B warning
 *  preamble) as an `exactOptionalPropertyTypes`-safe partial. Each field is
 *  omitted (not `undefined`) when absent so the pipeline stays byte-identical.
 *  Free function so the 3 presence ternaries live OUT of `runSessionLoop`'s
 *  complexity budget. */
const buildPromptPipelineNotifyDeps = (args: {
  readonly notify: import("../notify").NotificationPort | undefined
  readonly notifyCwdBasename: string | undefined
  readonly contextWarning: (() => string) | undefined
}): {
  notify?: import("../notify").NotificationPort
  notifyCwdBasename?: string
  contextWarning?: () => string
} => ({
  ...(args.notify !== undefined ? { notify: args.notify } : {}),
  ...(args.notifyCwdBasename !== undefined ? { notifyCwdBasename: args.notifyCwdBasename } : {}),
  ...(args.contextWarning !== undefined ? { contextWarning: args.contextWarning } : {}),
})

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

const drainTurnImages = (
  surfaceState: SessionState,
  promptImages: readonly import("@/llm").ImageBlock[],
): { readonly nextState: SessionState; readonly images: readonly import("@/llm").ImageBlock[] } => {
  const seedImages = surfaceState.pendingImages
  const nextState = updateSessionState(surfaceState, { pendingImages: [] })
  return {
    nextState,
    images: [...seedImages, ...promptImages],
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
    registerSideConversationStart,
    registerPlanQueueSendNow,
    runtimeFacadeCompose,
    playbookSeam,
    playbookCliFlag,
    searchPipelineDispose,
    notify,
    notifyCwdBasename,
    contextWarning,
  } = deps
  const {
    abort,
    statusBar,
    turnIndicator,
    turnSummary,
    runtimeContext,
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
    runtimeContext.automationEngine() ??
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
  const activeIdentityModeState = runtimeContext.identityModeState()
  const activeToolProfileState = runtimeContext.toolProfileState()
  const runtimeCompose =
    liveAutomationSlot !== undefined
      ? {
          ...(runtimeFacadeCompose ?? {}),
          automationEngine: liveAutomationSlot,
        }
      : runtimeFacadeCompose

  // L5 H-7 — single close stack (LIFO disposer registry). Each resource
  // registers its compensating teardown IMMEDIATELY after construction, so a
  // throw during the REST of session init can never leave a runtimeFacade,
  // session, or playbook watcher alive. `drainCloseStack` runs every disposer
  // exactly once, newest-first, and surfaces (does not rethrow) disposer
  // failures so one leaky teardown cannot mask the others (L5 M-1: MCP stop
  // failure is no longer swallowed silently — it lands as a warn here).
  const closeStack: Array<{ label: string; dispose: () => void | Promise<void> }> = []
  let closeStackDrained = false
  const drainCloseStack = async (): Promise<void> => {
    if (closeStackDrained) return
    closeStackDrained = true
    while (closeStack.length > 0) {
      const entry = closeStack.pop()
      if (entry === undefined) break
      try {
        await entry.dispose()
      } catch (e) {
        logger.warn(`session-loop teardown "${entry.label}" failed: ${errMessage(e)}`)
      }
    }
  }
  // Audit R1 C-F1 + R2 #2: every awaited/throwing INIT step that runs in the gap
  // between a close-stack registration and the branch try/finally blocks must
  // drain on throw — otherwise an already-registered facade/session/watcher
  // leaks. Wrapping each such step in `guardInit` closes the whole class (R1
  // missed `createSession`, which R2 then found). Drain is idempotent, so the
  // branch finallys still compose. Sync steps (e.g. attachPlaybookHandle) work
  // too — `await step()` accepts a non-promise return.
  const guardInit = async <T>(step: () => T | Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (e) {
      await drainCloseStack()
      throw e
    }
  }

  const runtimeFacade = await runtimeContext.createRuntimeFacade({
    boot: {
      mode: setup.mode,
      refreshSystemPrompt: setup.refreshSystemPrompt,
      toolProfileState: activeToolProfileState,
      identityModeState: activeIdentityModeState,
    },
    history: [...surfaceState.history],
    state: featureState,
    idMeta,
    shutdown: async () => undefined,
    mcpClients: setup.mcpClients as Array<{ stop: () => Promise<void> }>,
    ...(runtimeCompose !== undefined ? { compose: runtimeCompose } : {}),
  })
  closeStack.push({ label: "runtimeFacade.close", dispose: () => runtimeFacade.close() })
  const session = await guardInit(() =>
    runtimeFacade.createSession({
      cwd: setup.cwd,
      model: setup.model,
      // RFC-08 / ADR-0443 — when the mode-cycle store is wired, its CURRENT
      // posture seeds the session's permissionMode; otherwise the runtime
      // default. NOTE (honest limitation): `createSession` runs ONCE per REPL
      // session (the turn loop reuses the one session), and RuntimeContext
      // exposes permissionMode as a getter only — so a mid-session shift+tab
      // repaints the pill instantly but the NEW permission applies only to the
      // next freshly-created session, not the next turn of THIS one. A true
      // per-turn apply needs a runtime setter seam (deferred — see RFC-08 §2).
      permissionMode: ux?.modeCycle?.current().permissionMode ?? runtimeContext.permissionMode(),
      ...(activeIdentityModeState !== undefined
        ? { identityMode: activeIdentityModeState.get() }
        : {}),
      ...(activeToolProfileState !== undefined
        ? { toolProfile: activeToolProfileState.get() }
        : {}),
    }),
  )
  closeStack.push({ label: "session.close", dispose: () => session.close() })
  // L5 M-11 — tear down THIS session's search wire (delta-scan setInterval +
  // indexer) on session close so a long-lived session does not leak a scanning
  // interval. Threaded per-session: `searchPipelineDispose` is the bound
  // `searchWire.dispose` of the wire THIS session built (not a module
  // singleton), so two concurrent sessions each release their OWN wire. The
  // disposer is idempotent. Absent ⇒ no wire was built; nothing registered
  // (default-OFF byte-identical). Registration lives in the free helper so the
  // branch stays out of `runSessionLoop`'s complexity budget.
  registerSearchPipelineDispose(closeStack, searchPipelineDispose)
  // RFC-09 (A) — restore the terminal title on teardown. Idempotent + a no-op
  // when the port was never built (notify absent ⇒ byte-identical).
  registerNotifyDispose(closeStack, notify)
  registerSideConversationStart?.((args) => session.side.start(args))
  // `/queue` sendNow → inject the follow-up text as the next out-of-band
  // prompt. The store has already removed the entry by the time this fires.
  registerPlanQueueSendNow?.((inj) => {
    try {
      externalPromptQueue.push(inj.text)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: errMessage(e) }
    }
  })

  // ADR-0292 — install the `/rewind-conv` swap closure so the slash can mutate
  // the live history binding the loop reads each turn. No-throw on the swap;
  // a failure surfaces via logger.warn (already wrapped in the surface-compose
  // adapter — this is the inner closure the adapter delegates to).
  const installHistoryReplaceWire = (): void => {
    if (registerReplaceMessages === undefined) return
    registerReplaceMessages(async (msgs: ReadonlyArray<Message>): Promise<void> => {
      const result = await session.transcript.replace(msgs, undefined, { signal: abort.signal })
      const nextHistory = result.transcript?.messages ?? [...msgs]
      surfaceState = updateSessionState(surfaceState, { history: nextHistory })
    })
  }
  installHistoryReplaceWire()

  // ADR-0292 — turn-end record helper. No-op when the wire is null/absent so
  // the legacy code path is byte-identical (RFC §1.2). Defensive try/catch so
  // a misbehaving store NEVER bubbles into the loop.
  const recordTurnSnapshot = (msgs: readonly Message[]): void => {
    if (convCheckpointWire === undefined || convCheckpointWire === null) return
    try {
      convCheckpointWire.recordTurn(msgs)
    } catch (e) {
      logger.warn(`conv-checkpoint recordTurn threw: ${errMessage(e)}`)
    }
  }

  // ADR-0293 — playbook trigger lifecycle attach. The wire helper itself
  // implements the env/flag precedence + NOOP-handle short-circuit, so we
  // can call it unconditionally; only an active opt-in actually allocates
  // a watcher. Attach to the seam so /session finalize → seam.detach()
  // stops the handle even on abnormal shutdown.
  const attachPlaybookHandle = (): PlaybookTriggerWireHandle | undefined => {
    if (playbookSeam === undefined) return undefined
    const playbookSink: PlaybookPlanQueueSink = {
      enqueue: (input) => {
        try {
          externalPromptQueue.push(input.text)
          return { ok: true }
        } catch (e) {
          return {
            ok: false,
            reason: errMessage(e),
          }
        }
      },
    }
    const handle = maybeStartPlaybookTriggerWire({
      env: process.env,
      ...(playbookCliFlag !== undefined ? { cliFlag: playbookCliFlag } : {}),
      threadId: setup.sessionId,
      planQueueSink: playbookSink,
    })
    playbookSeam.attach(handle)
    return handle
  }
  // Audit R1 C-F1: attachPlaybookHandle() allocates a filesystem watcher
  // (maybeStartPlaybookTriggerWire) that can throw, in the same init gap —
  // guardInit drains the close stack on throw so the facade + session don't leak.
  await guardInit(() => attachPlaybookHandle())
  // L5 H-7 — register the playbook detach on the close stack the moment the
  // watcher is (possibly) attached, so a throw in the REST of init still stops
  // the file watcher. `detach()` is idempotent + a no-op when nothing attached.
  if (playbookSeam !== undefined) {
    closeStack.push({ label: "playbookSeam.detach", dispose: () => playbookSeam.detach() })
  }

  type SessionTurnPayload = NonNullable<Awaited<ReturnType<typeof session.turn.run>>["turn"]>

  const requireTurnPayload = (
    result: Awaited<ReturnType<typeof session.turn.run>>,
  ): SessionTurnPayload => {
    if (result.turn === undefined) {
      throw new Error("runtime session turn completed without a turn payload")
    }
    return result.turn
  }

  const completeRuntimeTurn = (
    turn: SessionTurnPayload,
  ): {
    readonly messages: readonly Message[]
    readonly outcomeReason?: AgentOutcome["reason"]
  } => ({
    messages: turn.messages,
    ...(turn.outcome.reason !== undefined ? { outcomeReason: turn.outcome.reason } : {}),
  })

  const resolvePendingApproval = async (
    approval: NonNullable<SessionTurnPayload["approvalRequest"]>,
    turnSignal: AbortSignal,
  ): Promise<void> => {
    const decision = await setup.approvalPrompt(approval)
    await session.approval.respond(approval.approvalId, decision, undefined, {
      signal: turnSignal,
    })
    if (decision === "deny") {
      throw new Error(`runtime session approval denied (${approval.reason})`)
    }
  }

  const runSessionTurn = async (args: {
    readonly text: string
    readonly images?: readonly import("@/llm").ImageBlock[]
    readonly turnSignal: AbortSignal
  }): Promise<{
    readonly messages: readonly Message[]
    readonly outcomeReason?: AgentOutcome["reason"]
  }> => {
    const { nextState, images } = drainTurnImages(surfaceState, args.images ?? [])
    surfaceState = nextState
    await session.input.append(args.text, images.length > 0 ? { images } : undefined, {
      signal: args.turnSignal,
    })
    for (;;) {
      const turn = requireTurnPayload(
        await session.turn.run(undefined, { signal: args.turnSignal }),
      )
      if (turn.approvalRequest === undefined) return completeRuntimeTurn(turn)
      await resolvePendingApproval(turn.approvalRequest, args.turnSignal)
    }
  }

  const runOneShotBranch = async (): Promise<void> => {
    try {
      const out = await runOneTurn<{
        readonly messages: readonly Message[]
        readonly outcomeReason?: AgentOutcome["reason"]
      }>(
        {
          outerAbort: abort,
          statusBar,
          turnIndicator,
          turnSummary,
          escWindowMs: ESC_WINDOW_MS,
          body: async (turnSignal) =>
            await runSessionTurn({ text: setup.argPrompt as string, turnSignal }),
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
            if (result.outcomeReason !== undefined) {
              lastTurnOutcome = mapAgentOutcomeToReactorOutcome({
                reason: result.outcomeReason,
              } as AgentOutcome)
            }
            // ADR-0292 — turn-end snapshot. No-op when the wire is null.
            recordTurnSnapshot(result.messages)
          },
          onError: sinks.renderTurnError,
        },
      )
      // RFC-09 (A) — turn-completion notify (one-shot path). Fires BEFORE the
      // finally drains the close stack (which restores the title via dispose).
      notifyTurnComplete(notify, out, notifyCwdBasename ?? "")
    } finally {
      // L5 H-7 — single teardown authority. Drains session.close +
      // runtimeFacade.close + playbookSeam.detach (registered above) LIFO,
      // even if the turn body threw before completing.
      await drainCloseStack()
    }
  }
  // One-shot dispatch: drive a SINGLE turn through `runOneTurn` then return.
  if (setup.argPrompt) {
    await runOneShotBranch()
    return
  }

  // Interactive dispatch: pills dispose first so a late paint cannot
  // resurrect a stale row AFTER the scroll region is reset.
  registerExitTeardown?.(() => {
    pills.dispose()
    statusBar.teardown()
  })

  // L5 H-7 — the interactive SETUP (automation ticker / reactor bridge /
  // prompt pipeline) plus the run loop live inside ONE try/finally so a throw
  // during any awaited setup step still drains the close stack (no leaked
  // facade / session / watcher / ticker / bridge on partial init).
  try {
    const automationTicker =
      liveAutomationSlot !== undefined
        ? startAutomationEngineTicker({ automationEngine: liveAutomationSlot } as AgentConfig)
        : undefined
    if (automationTicker !== undefined) {
      // L5 H-7 — register before the next awaited init step (reactor bridge) can
      // throw, so the ticker is stopped even on a partial interactive init.
      closeStack.push({ label: "automationTicker.stop", dispose: () => automationTicker.stop() })
    }

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
      // RFC-09 (A) idle path + (B) pre-compaction preamble. Each absent ⇒ the
      // pipeline behaves byte-identically.
      ...buildPromptPipelineNotifyDeps({ notify, notifyCwdBasename, contextWarning }),
    })

    // ADR-0453 jun-02 wire — composition-root binding of the reactor's 4th
    // guard (per-thread autorun eligibility). The resolver reads
    // `lastTurnOutcome` at CALL time (fresh per wake) via the getter so the
    // `on-failure` policy is evaluated against the most recent turn.
    const autorunEligibility = buildAutorunEligibility(process.env, () => lastTurnOutcome)
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
                ...(autorunEligibility !== undefined ? { eligibility: autorunEligibility } : {}),
              })
            },
            onError: (message) => {
              process.stderr.write(`${message}\n`)
            },
          })
        : undefined
    if (reactorBridge !== undefined) {
      closeStack.push({ label: "reactorBridge.close", dispose: () => reactorBridge.close() })
    }

    const runInteractiveBranch = async (): Promise<void> => {
      while (abort.signal.aborted !== true) {
        const next = await promptSource.next(abort.signal)
        if (next === null) break
        const prompt = normalizeCliPromptInput(next)
        const out = await runOneTurn<{
          readonly messages: readonly Message[]
          readonly outcomeReason?: AgentOutcome["reason"]
        }>(
          {
            outerAbort: abort,
            statusBar,
            turnIndicator,
            turnSummary,
            escWindowMs: ESC_WINDOW_MS,
            body: async (turnSignal) =>
              await runSessionTurn({
                text: prompt.text,
                images: prompt.images,
                turnSignal,
              }),
          },
          {
            onAfterResult: (result) => {
              surfaceState = updateSessionState(surfaceState, { history: result.messages })
              sinks.renderTurnDashboard()
              sinks.renderAndResetSummary(result)
              sinks.flushLifecyclePills()
              if (result.outcomeReason !== undefined) {
                lastTurnOutcome = mapAgentOutcomeToReactorOutcome({
                  reason: result.outcomeReason,
                } as AgentOutcome)
              }
              recordTurnSnapshot(result.messages)
            },
            onError: sinks.renderTurnError,
          },
        )
        process.stderr.write("\n")
        if (out.turnAborted || out.result === undefined) {
          lastTurnOutcome = "fail"
        }
        // RFC-09 (A) — turn-completion notify (interactive path).
        notifyTurnComplete(notify, out, notifyCwdBasename ?? "")
      }
    }

    await runInteractiveBranch()
  } finally {
    // L5 H-7 — single teardown authority. LIFO drain stops background
    // producers (reactor bridge, automation ticker) and the playbook watcher
    // BEFORE closing the session + runtimeFacade, matching the prior manual
    // order, and runs even on abnormal shutdown. Idempotent.
    await drainCloseStack()
  }
}
