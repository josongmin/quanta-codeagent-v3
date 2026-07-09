import type { AgentConfig, AgentOutcome } from "@/agent"
import type { InboundMode } from "@/agent/inbound-mode"
import { startAutomationEngineTicker } from "@/agent/loop-helpers"
import type { Message } from "@/llm"
import { buildAutorunEligibility } from "@/permission"
import {
  injectSimulatedTurn,
  type LastTurnOutcome,
  lastTurnOutcomeFromAgentOutcome,
  REACTOR_ENV_FLAG,
} from "@/reactor"
import { driveSessionTurn } from "@/runner/orchestrate"
import { createCronSlashAdapter } from "@/scheduler"
import { assembleAutomation } from "@/scheduler/runtime-wire"
import type {
  RuntimeFacadeComposeOptions,
  RuntimeSideConversationArgs,
  RuntimeSideConversationResult,
} from "@/sdk/runtime"
import { errMessage, gateOnStrict, logger, runtimeConfig } from "@/shared"
import type { PlaybookPlanQueueSink } from "@/skill/playbook"
import { readCliKnob } from "../cli-knobs-accessor"
import { startReactorWatchBridge } from "../reactor-watch-bridge"
import { wireInboxBannerOntoSlot } from "./automation-banner"
import type { ConvCheckpointWire } from "./conv-checkpoint-wire"
import type { ConversationActionSurface } from "./conversation-action-surface"
import { ExternalPromptQueue } from "./external-prompt-queue"
import { createHeartbeatBinder, heartbeatEnqueueHandler } from "./heartbeat-binder"
import type { InTurnReaderStdin } from "./in-turn-reader"
import { type MidTurnCaptureHandle, maybeCreateMidTurnCaptureWire } from "./mid-turn-capture-wire"
import { maybeCreateNdjsonSinkWire } from "./ndjson-wire"
import type { PlaybookTriggerSurfaceSeam } from "./playbook-trigger-surface-seam"
import {
  maybeStartPlaybookTriggerWire,
  type PlaybookTriggerWireHandle,
} from "./playbook-trigger-wire"
import { composePromptPipeline, type DispatchSlash } from "./prompt-pipeline"
import { maybeCreatePromptSuggestionWire } from "./prompt-suggestion-wire"
import { normalizeCliPromptInput } from "./prompt-types"
import {
  buildPromptPipelineNotifyDeps,
  drainTurnImages,
  ESC_WINDOW_MS,
  handleMovedToBackground,
  makeInTurnCaptureWrapper,
  notifyTurnComplete,
  registerNotifyDispose,
  registerSearchPipelineDispose,
  shouldWireBackground,
  warnLiveBackgroundTurns,
} from "./session-loop/turn-helpers"
import type { SessionSetupResult } from "./session-setup"
import { type SessionState, updateSessionState } from "./session-state"
import { runOneTurn } from "./turn-runner"

// Re-export the complete prior public surface so every importer of
// `./session-loop` stays byte-compatible (the helper cluster moved to the
// sibling `./session-loop/turn-helpers`, but `shouldWireBackground` was a
// public export consumed by the background-ctrlb hellgate test).
export { shouldWireBackground }

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
  /** ADR-0528 L2 (auto-reinject) — prompts seeded into the live
   *  `ExternalPromptQueue` BEFORE the interactive loop starts, so they win the
   *  prompt-source race and run as the FIRST turn(s). The host uses it to
   *  re-inject an accepted crash-resume `offer.resumeMessage`. Absent/empty ⇒
   *  no push, byte-identical. Interactive-only (one-shot ignores it). */
  readonly seedPrompts?: readonly string[]
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
  /** B2 (jul-04 CLI-surfacing) — `/cron` automation slash slot install. The loop
   *  mints the automation engine (`liveAutomationSlot`) and, when present, builds
   *  the thin `createCronSlashAdapter` over its port + installs it here so
   *  `/cron`/`/schedule`/`/inbox` list/create/read against the LIVE engine. Absent
   *  engine ⇒ never called ⇒ the slot stays undefined ⇒ `/cron` prints "not
   *  wired" (default-OFF byte-identical). */
  readonly registerAutomationSlash?: (
    fn: import("../slash/cron-cmd").AutomationSlashState | undefined,
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
  /** #8 — the live plan-queue store the surface owns (the SAME store `/queue`
   *  reads). Threaded so the loop can build the mid-turn capture facade over it
   *  when `QUANTA_MIDTURN_CAPTURE=1`. Absent ⇒ no capture wire (default-OFF
   *  byte-identical). */
  readonly planQueueStore?: import("@/agent/plan-queue").PlanQueueStore
  /** #8 last-mile (jun-6) — the live stdin source for the CONCURRENT in-turn
   *  keystroke reader (closed-port DI; the host binds `process.stdin`, tests bind
   *  a fake). Only consumed when the mid-turn-capture wire is PRESENT
   *  (`QUANTA_MIDTURN_CAPTURE=1` + a plan-queue store + a thread id). Absent ⇒ no
   *  reader is ever started ⇒ stdin stays detached during the turn, byte-identical
   *  to today (the SACRED default-OFF invariant). */
  readonly inTurnStdin?: InTurnReaderStdin
  /** §steer — the conversation-action surface (weave `pushUserMessage` /
   *  interrupt `pushCancel` + the live `activeTurnRef`). Threaded so a mid-turn
   *  line can be WOVEN into the current turn or INTERRUPT it (vs the default
   *  next-turn queue). Present only when `QUANTA_CONVERSATION_ACTIONS=1`. Absent
   *  ⇒ every mode degrades to the queue path (byte-identical). */
  readonly conversationActions?: ConversationActionSurface
  /** §steer — the session-mutable inbound delivery mode (`queue` default).
   *  Mutated by `/inbound`. Absent or `queue` ⇒ the existing next-turn capture
   *  path (byte-identical). `weave`/`interrupt` route through {@link handleInboundLine}
   *  (only effective when `conversationActions` is also present). */
  readonly inboundMode?: { current: InboundMode }
  /** Ticket 18 (V1) — the background-turn portal (present iff `QUANTA_BG_TURN`).
   *  When wired AND the WEAVE guard allows it, the INTERACTIVE turn passes
   *  `onMovedToBackground` to `runOneTurn` so Ctrl+B detaches the running turn
   *  into this portal (the body keeps streaming; the loop returns to a fresh
   *  prompt). Absent ⇒ Ctrl+B is unwired ⇒ the turn path is byte-identical
   *  (default-OFF). The one-shot path NEVER wires it (no prompt to return to). */
  readonly backgroundPortal?: import("./background-turn-portal").BackgroundTurnPortal
}

/** ALBB-14 double-arm fix — project the REPL's live automation slot onto the
 *  per-turn `runAgent` CONFIG path with the `handler` DROPPED. The REPL owns a
 *  persistent session-scoped ticker (the single owner); the config-path slot
 *  needs only `engine` (for the `automation_update` tool). Dropping `handler`
 *  makes the shared-lifecycle bootstrap ticker short-circuit
 *  (`startAutomationEngineTicker` returns `undefined` when `handler` is absent)
 *  so it never arms a SECOND `setInterval` on the same engine during a turn.
 *  `undefined` in ⇒ `undefined` out (no slot ⇒ no compose entry). */
export const stripAutomationTickerHandler = (
  slot: NonNullable<AgentConfig["automationEngine"]> | undefined,
): NonNullable<AgentConfig["automationEngine"]> | undefined => {
  if (slot === undefined) return undefined
  const { handler: _replOwnedHandler, ...engineOnly } = slot
  return engineOnly
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
    registerAutomationSlash,
    runtimeFacadeCompose,
    playbookSeam,
    playbookCliFlag,
    searchPipelineDispose,
    notify,
    notifyCwdBasename,
    contextWarning,
    backgroundPortal,
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
  // ADR-0528 L2 (auto-reinject) — seed prompts BEFORE the interactive loop's
  // prompt-source race begins, so each wins immediately and runs as the first
  // turn(s) (the host re-injects an accepted crash-resume `resumeMessage`).
  // Empty/absent ⇒ no push (byte-identical). One-shot branch never reads the
  // queue, so a seed there would be inert — host only seeds interactive.
  for (const seed of deps.seedPrompts ?? []) externalPromptQueue.push(seed)
  // H8 last-mile (ADR-0480) — the heartbeat thread-resume binder. A heartbeat
  // fire (scheduler `enqueueUserMessage(message, { targetThreadId, ... })`)
  // routes through the binder so the TARGET thread is resumed under its
  // inherited (clamped) posture; a bare CRON push (`targetThreadId` absent) is
  // byte-identical to `externalPromptQueue.push(message)`. The getter closures
  // resolve the LIVE session id + per-turn permission cell at fire time (not a
  // stale snapshot): `surfaceState` is a reassigned `let`, so reading
  // `surfaceState.sessionId` inside the closure sees the current thread id.
  const heartbeatBinder = createHeartbeatBinder({
    liveThreadId: () => surfaceState.sessionId,
    permissionCell: () => runtimeContext.permissionModeState(),
    pushPrompt: (prompt) => externalPromptQueue.push(prompt),
  })
  const enqueueWithHeartbeat = heartbeatEnqueueHandler({
    binder: heartbeatBinder,
    pushPrompt: (prompt) => externalPromptQueue.push(prompt),
  })
  // #8 last-mile (jun-6) — mid-turn keystroke capture SEAM + the CONCURRENT
  // in-turn SOURCE that now feeds it. Default-OFF: the wire is `undefined` unless
  // `QUANTA_MIDTURN_CAPTURE=1` (read via runtimeConfig — no direct env access
  // here) AND the surface supplied its plan-queue store + a thread id. With the
  // wire absent NOTHING captures mid-turn input AND no reader is ever started ⇒
  // the input/turn loop is byte-identical to today (stdin stays detached during
  // the turn, exactly as before — the SACRED invariant). When the wire IS present
  // the loop starts an `in-turn-reader` right before each `await runOneTurn` and
  // disposes it in the `finally` (see `withInTurnCapture`), so every completed
  // line typed WHILE the turn streams lands on the plan-queue + the turn-boundary
  // `externalPromptQueue` drain.
  const midTurnCapture: MidTurnCaptureHandle | undefined =
    deps.planQueueStore !== undefined
      ? maybeCreateMidTurnCaptureWire({
          enabled: runtimeConfig().midTurnCapture,
          threadId: setup.sessionId,
          planQueue: deps.planQueueStore,
          pushExternal: (text) => externalPromptQueue.push(text),
        })
      : undefined
  // Wrap a `runOneTurn` invocation with the concurrent in-turn reader (+ optional
  // input lane). Extracted to a module factory so `runSessionLoop` stays under the
  // cognitive-complexity cap; the factory owns the per-turn index counter + the
  // §08b `QUANTA_MIDTURN_VISIBLE`+TTY gate.
  const withInTurnCapture = makeInTurnCaptureWrapper({
    midTurnCapture,
    inTurnStdin: deps.inTurnStdin,
    inboundMode: deps.inboundMode,
    conversationActions: deps.conversationActions,
    externalPromptQueue,
    midTurnVisibleKnob: runtimeConfig().midTurnVisible,
    midTurnApprovalChannel: setup.midTurnApprovalChannel,
  })
  let lastUserInputAt = 0
  let lastTurnOutcome: LastTurnOutcome | undefined
  const liveAutomationSlot =
    runtimeContext.automationEngine() ??
    assembleAutomation(
      { get: (name) => process.env[name] },
      {
        agentLoop: {
          enqueueUserMessage: enqueueWithHeartbeat,
        },
      },
    ) ??
    undefined
  // B2 (jul-04 CLI-surfacing) `/cron` — LATE-BIND the automation slash slot the
  // instant the engine exists. The engine is minted HERE (inside the loop, after
  // the surface wire bundle was built), so the surface's `/cron` slot could not
  // be populated at compose time (unlike `/kb`, whose store is minted in
  // `buildTooling`). Mirrors `registerSideConversationStart` (installed once the
  // live session method exists): build the thin adapter over the live engine port
  // (RRULE parse + next-fire compute via `@/scheduler`, no new dep) and install it
  // so `/cron`/`/schedule`/`/inbox` list/create/read the LIVE engine. Absent
  // engine ⇒ never called ⇒ `/cron` stays "not wired" (default-OFF byte-identical).
  if (liveAutomationSlot !== undefined && registerAutomationSlash !== undefined) {
    registerAutomationSlash(createCronSlashAdapter({ engine: liveAutomationSlot.engine }))
  }
  const activeIdentityModeState = runtimeContext.identityModeState()
  const activeToolProfileState = runtimeContext.toolProfileState()
  // ALBB-14 double-arm fix — the REPL owns a persistent per-session automation
  // ticker (armed below over `liveAutomationSlot`, alive across BOTH active
  // turns AND idle prompt windows). The per-turn `runAgent` config would ALSO
  // arm the shared-lifecycle ticker (`maybeStartAutomationTicker` in
  // session-bootstrap) on the SAME engine — a second `setInterval` running
  // DURING every turn (double-tick; atomic `engine.claim` prevents a
  // double-FIRE, but the redundant timer/claim churn is pure waste). The
  // config-path slot carries only what the `automation_update` tool needs
  // (`engine`); `stripAutomationTickerHandler` drops the `handler` so the
  // bootstrap ticker short-circuits (`startAutomationEngineTicker` returns
  // `undefined` when `handler` is absent), leaving the REPL ticker the SINGLE
  // owner. Non-CLI surfaces (web-daemon / headless) keep their `handler` and
  // are still armed by the shared lifecycle — the ALBB-14 goal is preserved.
  const composeAutomationEngine = stripAutomationTickerHandler(liveAutomationSlot)
  const runtimeCompose =
    composeAutomationEngine !== undefined
      ? {
          ...(runtimeFacadeCompose ?? {}),
          automationEngine: composeAutomationEngine,
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
      // default. ADR-0303 closed the former "applies only next session" gap:
      // `permissionModeState` is now an engine-owned cell behind
      // `permission.mode`'s accessor, and `runSessionTurn` syncs the latest
      // posture into it BEFORE each turn — so a mid-session shift+tab applies on
      // the very next turn, read live by the admissibility gate.
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

  // ADR-0303 — the `append → turn.run → resolve-approval → loop` turn-completion
  // primitive lives below the surface in `@/runner/orchestrate` (driveSessionTurn)
  // so the CLI interactive + one-shot branches AND headless share ONE definition.
  // This thin adapter keeps the CLI-only concerns in the surface: the per-turn
  // image drain (mutates surfaceState) and the §3.1 permission-posture sync (read
  // the slash-local mode-cycle, write the engine-owned permissionModeState cell
  // BEFORE the turn). Signature is preserved so the call sites are unchanged.
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
    // Capture in a const so the non-undefined narrowing survives into the
    // beforeTurn closure (a `let`/optional-chain would re-widen to | undefined).
    const modeCycle = ux?.modeCycle
    return driveSessionTurn({
      session,
      resolveApproval: setup.approvalPrompt,
      text: args.text,
      images,
      turnSignal: args.turnSignal,
      // ADR-0528 — env THREADED from the composition root (this CLI surface IS
      // an allowed `process.env` reader); the crash-resume marker reads its gate
      // off THIS env, never an ambient literal below the surface.
      env: process.env,
      // ADR-0528 — crash-resume marker for the durable (id-mode) session;
      // gate-gated + no-op when the session id is absent/ephemeral.
      ...(setup.sessionId !== undefined ? { sessionId: setup.sessionId } : {}),
      // host concern — absent cycle ⇒ no hook ⇒ byte-identical.
      ...(modeCycle !== undefined
        ? {
            beforeTurn: () => {
              runtimeContext.permissionModeState()?.set(modeCycle.current().permissionMode)
            },
          }
        : {}),
    })
  }

  const runOneShotBranch = async (): Promise<void> => {
    try {
      // #8 last-mile (jun-6) — the concurrent in-turn reader wraps the awaited
      // turn (no-op passthrough when capture is off ⇒ byte-identical).
      const out = await withInTurnCapture(() =>
        runOneTurn<{
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
                lastTurnOutcome = lastTurnOutcomeFromAgentOutcome({
                  reason: result.outcomeReason,
                } as AgentOutcome)
              }
              // ADR-0292 — turn-end snapshot. No-op when the wire is null.
              recordTurnSnapshot(result.messages)
            },
            onError: sinks.renderTurnError,
          },
        ),
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
    // #22 — opt-in (`QUANTA_AUTOMATION_INBOX`, default-OFF) inbox banner: compose
    // `[automation inbox: N]` onto the slot's existing onTick so the live ticker
    // paints unread counts on each fire. OFF ⇒ slot untouched (byte-identical).
    const automationSlotForTicker =
      liveAutomationSlot !== undefined
        ? wireInboxBannerOntoSlot(liveAutomationSlot, {
            enabled: readCliKnob("QUANTA_AUTOMATION_INBOX", "bool") ?? false,
          }).slot
        : undefined
    const automationTicker =
      automationSlotForTicker !== undefined
        ? startAutomationEngineTicker({ automationEngine: automationSlotForTicker } as AgentConfig)
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
      setup.sessionId !== undefined && gateOnStrict(process.env, REACTOR_ENV_FLAG)
        ? await startReactorWatchBridge({
            sessionId: setup.sessionId,
            onTrigger: async (trigger) => {
              await injectSimulatedTurn({
                trigger,
                agentLoop: {
                  // Reactor port returns Promise<void>; the handler's WS-D
                  // non-delivery verdict is a heartbeat-path shape (needs a
                  // targetThreadId, which the reactor never passes) — void it.
                  enqueueUserMessage: async (message, opts) => {
                    await enqueueWithHeartbeat(message, opts)
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

    // ADR-0468 — NDJSON live-introspection sink. Default-OFF: NullNdjsonSink
    // (no socket/file/alloc) unless QUANTA_NDJSON_INGEST_PORT / _FILE is set.
    const ndjson = maybeCreateNdjsonSinkWire({ env: process.env, logger })
    closeStack.push({ label: "ndjson.stop", dispose: () => ndjson.stop() })
    // ADR-0467 — prompt-suggestion wire. Default-OFF: null (zero LLM, zero
    // render) unless QUANTA_ENABLE_PROMPT_SUGGESTION === "1".
    const promptSuggestion = maybeCreatePromptSuggestionWire(process.env, setup.llm, (text) =>
      process.stderr.write(`\x1b[2m${text}\x1b[0m\n`),
    )
    const runInteractiveBranch = async (): Promise<void> => {
      while (abort.signal.aborted !== true) {
        const next = await promptSource.next(abort.signal)
        if (next === null) break
        const prompt = normalizeCliPromptInput(next)
        // Ticket 18 (V1) — discoverable turn-start hint. Painted ONLY when the
        // Ctrl+B detach is actually wired for THIS turn (portal present + WEAVE
        // guard satisfied) so the affordance never advertises a no-op key.
        if (
          shouldWireBackground({
            portal: backgroundPortal,
            inboundMode: deps.inboundMode,
            conversationActions: deps.conversationActions,
          })
        ) {
          process.stderr.write("\x1b[2m· Ctrl+B background · Esc Esc cancel\x1b[0m\n")
        }
        // #8 last-mile (jun-6) — the concurrent in-turn reader wraps the awaited
        // turn (no-op passthrough when capture is off ⇒ byte-identical). The
        // turn-boundary reader (`promptSource.next` above) has already resolved +
        // detached, so the in-turn reader is the ONLY stdin consumer for the turn.
        const out = await withInTurnCapture(() =>
          runOneTurn<{
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
              // Ticket 18 (V1) — Ctrl+B detach. Wired ONLY when the portal exists
              // AND the WEAVE guard allows it (see `shouldWireBackground`): in
              // weave / mid-interrupt the sink is omitted ⇒ Ctrl+B is a no-op and
              // the FSM is byte-identical. On detach: register the LIVE body
              // promise + the turn's AbortController with the portal; the body
              // keeps streaming, the loop returns to a fresh prompt (the
              // `out.backgrounded` skip below), and the portal fires the existing
              // notify port on completion.
              ...(shouldWireBackground({
                portal: backgroundPortal,
                inboundMode: deps.inboundMode,
                conversationActions: deps.conversationActions,
              })
                ? {
                    // Detach side-effects (portal register + WS-H capture tee +
                    // breadcrumbs + notify reuse) live in the free helper so the
                    // branch stays out of this function's god-fn budget.
                    onMovedToBackground: (handle) =>
                      handleMovedToBackground({
                        portal: backgroundPortal,
                        capture: setup.backgroundStreamCapture,
                        promptText: prompt.text,
                        notify,
                        notifyCwdBasename,
                        write: (s) => process.stderr.write(s),
                        handle,
                      }),
                  }
                : {}),
            },
            {
              onAfterResult: (result) => {
                surfaceState = updateSessionState(surfaceState, { history: result.messages })
                sinks.renderTurnDashboard()
                sinks.renderAndResetSummary(result)
                sinks.flushLifecyclePills()
                if (result.outcomeReason !== undefined) {
                  lastTurnOutcome = lastTurnOutcomeFromAgentOutcome({
                    reason: result.outcomeReason,
                  } as AgentOutcome)
                }
                recordTurnSnapshot(result.messages)
                // ADR-0468 — mirror the turn boundary to the introspection sink.
                // No-op (no alloc) when the sink is the default-OFF NullNdjsonSink.
                ndjson.sink.emit({
                  type: "turn.complete",
                  ts: Date.now(),
                  messageCount: result.messages.length,
                })
              },
              onError: sinks.renderTurnError,
            },
          ),
        )
        // Ticket 18 (V1) — the turn was moved to the background (Ctrl+B). The
        // portal now owns the live body promise; skip the history fold / notify
        // / suggestion and return to `promptSource.next` for a FRESH prompt. V1
        // does NOT fold a backgrounded turn into surface `history` (the SDK
        // session is SSOT — documented limitation, not a bug).
        if (out.backgrounded === true) continue
        process.stderr.write("\n")
        // ALBB-18 (1) — label fidelity: an Esc-Esc / turn-abort is the SAME
        // terminal reason (`"aborted"`) the happy path routes through the SSOT
        // classifier, which maps it to `"partial"` — so route the abort branch
        // through the SAME SSOT rather than hardcoding `"fail"` (which disagreed
        // with the classifier for the identical reason). A genuine no-result /
        // error with NO abort stays `"fail"`. No behavioral effect today (self-
        // wake Guard 3 blocks both `"fail"` AND `"partial"`); this pins the label
        // to the SSOT so a future Guard-3 loosening cannot make the mislabel
        // silently load-bearing.
        if (out.turnAborted) {
          lastTurnOutcome = lastTurnOutcomeFromAgentOutcome({ reason: "aborted" } as AgentOutcome)
        } else if (out.result === undefined) {
          lastTurnOutcome = "fail"
        }
        // RFC-09 (A) — turn-completion notify (interactive path).
        notifyTurnComplete(notify, out, notifyCwdBasename ?? "")
        // ADR-0467 — prompt suggestion (pre-next-prompt). No-op when the wire
        // is null (default-OFF). No-throw: run() always resolves.
        await promptSuggestion?.run({
          messages: surfaceState.history,
          // The suppression-context view is conservative: the CLI session loop
          // exposes no live plan-mode / rate-limit / elicitation / pending-
          // permission signal here, so all four are `false`. This only widens
          // when (not whether) a suggestion shows — the reject-gate (the crown
          // jewel) still vets every model output fully. Thread real signals here
          // if the surface starts tracking them.
          state: {
            planMode: false,
            rateLimited: false,
            elicitationActive: false,
            pendingPermission: false,
          },
          signal: abort.signal,
        })
      }
    }

    await runInteractiveBranch()
    // Print resume link after clean /exit so the user can continue later.
    if (setup.stderrIsTTY === true && idMeta !== undefined) {
      process.stderr.write(`\x1b[2mResume: quanta --resume ${idMeta.id}\x1b[0m\n`)
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
