import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import {
  AgentStatePanel,
  agentStateHasContent,
  type PlanInputAnswer,
} from "./components/AgentStatePanel"
import { ChatPanel } from "./components/ChatPanel"
import { ConnectionUrlPill } from "./components/ConnectionUrlPill"
import type { EscalationDecision } from "./components/EscalationCard"
import { HeaderTitle } from "./components/HeaderTitle"
import { HotkeyToast } from "./components/HotkeyToast"
import { KnobsPanel } from "./components/KnobsPanel"
import { ModeBadge } from "./components/ModeBadge"
import { ObservabilityPane } from "./components/ObservabilityPane"
import { PlanPanel } from "./components/PlanPanel"
import { PortBadge } from "./components/PortBadge"
import type { SlashCommand, SlashCommandContext } from "./components/SlashPalette"
import { StatusBar } from "./components/StatusBar"
import { SubAgentsPanel, subagentHasContent } from "./components/SubAgentsPanel"
import { assembleSlashCommands, resolveSlashCommandFrom } from "./components/slash-catalog"
import type { KnobsEndpoint } from "./components/slash-knobs"
import { httpUrlFromWsUrl } from "./components/slash-llm-config"
import { executeSlashCommand, type SlashAcceptOutcome } from "./components/slash-routing"
import { ThreadDeeplinkBanner } from "./components/ThreadDeeplinkBanner"
import { ThreadPicker } from "./components/ThreadPicker"
import { TokenCounter } from "./components/TokenCounter"
import { isHotkeyImagePayload, type PendingImageAttachment } from "./composer/image-attachment"
import { useImageAttachment } from "./composer/use-image-attachment"
import {
  BOOTSTRAP_MAX_ATTEMPTS,
  bootstrapRetryDelayMs,
  composerEnabled,
  connectionBanner,
  INITIAL_UI_CONNECTION,
  transitionUiConnection,
} from "./lib/connection-state"
import { hydrateThreadResume, type ThreadResumeBoundary } from "./lib/thread-resume"
import { hydrateTranscript } from "./lib/transcript-hydrate"
import { installTurnCompleteNotifyBrowser } from "./lib/turn-complete-notify"
import type {
  AgentStateMessage,
  ConnectionState,
  ContextUsageMessage,
  SessionStateView,
} from "./types/protocol"
import { type AgentStateSource, useAgentState } from "./ws/agent-state-hooks"
import { type CanvasSource, useArtifacts, useContextUsage, useToolDiffs } from "./ws/canvas-hooks"
import { type ConnectOptions, SessionClient } from "./ws/client"
import { useItemStream } from "./ws/item-stream-hooks"
import {
  type ObservabilitySource,
  type ObservabilityState,
  useObservabilityState,
} from "./ws/observability-hooks"
import { usePendingApprovals } from "./ws/pending-approvals"
import {
  type CumulativeTokenUsage,
  shouldContinueAfterApproval,
  useConnectionState,
  useSendApprovalDecision,
  useSendCancel,
  useSendPermissionMode,
  useSendTurn,
  useServerAutoContinues,
  useSessionEvents,
} from "./ws/session-hooks"
import { type SubagentMessage, type SubagentSource, useSubagentState } from "./ws/subagent-model"

export type { PendingImageAttachment }

/**
 * Top-level app shell.
 *
 * Owns:
 *   - the SessionClient singleton (one per page load)
 *   - the chat input string (controlled component for InputBar)
 *   - the "hotkey capture" payload that HotkeyToast appends to input
 *
 * Config resolution order (precedence highest to lowest):
 *   1. `window.__QUANTA_CONFIG__`  — injected by the Tauri shell at boot
 *      with the per-launch random port and auth token. Always wins when
 *      present (i.e. when running inside the desktop app).
 *   2. `import.meta.env.VITE_QUANTA_WS_URL` / `VITE_QUANTA_AUTH_TOKEN`
 *      — build-time defaults for `bun run dev` standalone browser use.
 *   3. Hard-coded `ws://127.0.0.1:4096/` fallback (matches the daemon's
 *      default bind when no env or injection is present).
 */

const DEFAULT_WS_URL = "ws://127.0.0.1:4096/"
const TAURI_BOOTSTRAP_RETRY_MS = 200
const TAURI_BOOTSTRAP_MAX_ATTEMPTS = 25

// Send-hotkey auto-prompt: used when the user fires `Cmd+Ctrl+Shift+]`
// while images are pending but the draft is empty. Lets the screenshot
// flow be a single-key "capture → send with standard ask" path.
const HOTKEY_SEND_IMAGE_PROMPT =
  "위 이미지들을 기반으로 문제파악하고 최적의 솔루션을 알려줘. 간결하게 답을 문제코드위에 그대로 덮어서주고, 변경된건 주석으로 표현"

interface QuantaInjectedConfig {
  readonly wsUrl?: string
  readonly authToken?: string
}

interface TauriInvokeError {
  readonly code?: string
  readonly message?: string
}

interface DaemonInfoPayload {
  readonly wsUrl: string
  readonly authToken?: string
}

interface SessionChromeProps {
  readonly connection: ConnectionState
  readonly model: string
  readonly resolvedConnection: { url: string; token?: string } | null
  readonly sessionState: SessionStateView | null
  readonly tokenUsage: CumulativeTokenUsage
  readonly canRestartDaemon: boolean
  readonly onCancel?: () => void
  readonly onSetPermission?: (mode: string) => void
  /** P2 (UUX-4-18) — latest context.usage frame for the StatusBar warning chip. */
  readonly contextUsage: { readonly total: number; readonly max: number } | null
}

const getEnv = (key: "VITE_QUANTA_WS_URL" | "VITE_QUANTA_AUTH_TOKEN"): string | undefined => {
  const env = (
    import.meta as unknown as {
      env?: Partial<Record<string, string>>
    }
  ).env
  return env?.[key]
}

/**
 * Mobile-share entry point: the URL pill on the desktop emits links of the
 * form `http://<lan-ip>:5173/?ws=<encoded-ws>&token=<token>` so a phone on
 * the same Wi-Fi can scan-and-go. We pluck those query params before
 * anything else so the share URL wins over Tauri / env defaults (which
 * would point the mobile browser at its own 127.0.0.1).
 */
const readQueryConfig = (): { wsUrl: string; authToken?: string } | undefined => {
  if (typeof window === "undefined") return undefined
  try {
    const params = new URLSearchParams(window.location.search)
    const ws = params.get("ws")
    if (ws === null || ws.length === 0) return undefined
    const token = params.get("token")
    return token !== null && token.length > 0 ? { wsUrl: ws, authToken: token } : { wsUrl: ws }
  } catch {
    return undefined
  }
}

const readInjectedConfig = (): QuantaInjectedConfig | undefined => {
  if (typeof window === "undefined") return undefined
  const injected = (
    window as unknown as {
      __QUANTA_CONFIG__?: QuantaInjectedConfig
    }
  ).__QUANTA_CONFIG__
  if (injected === undefined || injected === null) return undefined
  if (typeof injected !== "object") return undefined
  return injected
}

const isLikelyTauriWebview = (): boolean => {
  if (typeof window === "undefined") return false
  const location = window.location
  if (location.protocol === "tauri:") return true
  if (location.protocol === "http:" && location.hostname.endsWith(".localhost")) {
    return true
  }
  return "__TAURI_INTERNALS__" in window
}

const toResolved = (url: string, token: string | undefined): { url: string; token?: string } =>
  typeof token !== "string" || token.length === 0 ? { url } : { url, token }

const resolveConnectionConfig = async (): Promise<{ url: string; token?: string }> => {
  const fromQuery = readQueryConfig()
  if (fromQuery !== undefined) {
    return toResolved(fromQuery.wsUrl, fromQuery.authToken)
  }

  const injected = readInjectedConfig()
  if (typeof injected?.wsUrl === "string" && injected.wsUrl.length > 0) {
    return toResolved(injected.wsUrl, injected.authToken)
  }

  const tauriInvoke = readTauriInvoke()
  if (tauriInvoke !== undefined) {
    const daemon = await resolveTauriDaemonInfo(tauriInvoke)
    return toResolved(daemon.wsUrl, daemon.authToken)
  }

  if (isLikelyTauriWebview()) {
    throw new Error("tauri bootstrap config not ready")
  }

  return toResolved(
    getEnv("VITE_QUANTA_WS_URL") ?? DEFAULT_WS_URL,
    getEnv("VITE_QUANTA_AUTH_TOKEN"),
  )
}

/**
 * Auto-hide gate for the observability sidebar (Codex-like): the pane stays
 * off-screen until there is something to show. Pure + exported so the
 * byte-identical "no canvas ⇒ pane hidden" invariant is unit-testable without a
 * React renderer (the test env is `node`, no DOM). Returns `true` when ANY of
 * runs / objective / approvals / context-usage is present.
 */
export const computeHasObservabilityData = (
  observability: ObservabilityState,
  contextUsage: ContextUsageMessage | null,
  hasDiffs = false,
  /** QUANTA_WEB_AGENT_STATE — true when the agent-state channel carries a live
   *  plan OR any agent-state axis (mode / tool-progress / compaction / ratelimit
   *  / plan-prompt). Opens the sidebar so the agent-state column is not rendered
   *  into a collapsed pane. Default `false` keeps existing callers byte-identical. */
  hasAgentState = false,
  /** A2 / S2 — true when the canvas channel carries a ready artifact
   *  (`useArtifacts`) OR the `item.*` stream carries an activity item
   *  (`useItemStream`). Opens the sidebar so the strip / activity section is not
   *  rendered into a collapsed pane. Default `false` keeps existing callers
   *  byte-identical. */
  hasCanvasExtras = false,
): boolean =>
  observability.runs.length > 0 ||
  observability.objective !== null ||
  observability.approvals.length > 0 ||
  contextUsage !== null ||
  hasDiffs ||
  hasAgentState ||
  hasCanvasExtras

/**
 * B2 — the resume banner's UI state machine. Extracted (exported) so the
 * "resuming… → resumed(boundary) / failed" copy — including the HONEST
 * read-only-history vs live-attach distinction — is testable without a React
 * renderer (the test env is `node`, no DOM). `idle` yields `null` (no chrome).
 */
export type ResumeUiState =
  | { phase: "idle" }
  | { phase: "resuming"; threadId: string }
  | { phase: "resumed"; threadId: string; boundary: ThreadResumeBoundary; count: number }
  | { phase: "failed"; threadId: string }

export const formatResumeStatus = (state: ResumeUiState): string | null => {
  switch (state.phase) {
    case "idle":
      return null
    case "resuming":
      return `Resuming thread ${state.threadId}…`
    case "resumed": {
      const plural = state.count === 1 ? "" : "s"
      const boundaryNote =
        state.boundary === "read-only-history"
          ? " (read-only history — new messages continue the live session)"
          : " (live)"
      return `Resumed ${state.count} event${plural} from thread ${state.threadId}${boundaryNote}`
    }
    case "failed":
      return `Could not resume thread ${state.threadId}.`
  }
}

/**
 * P1 Phase 3b — the ConnectOptions for OPENING a persisted thread. Re-dialing
 * the WS with `resumeThreadId` set makes the daemon SWAP its one live session
 * onto that thread (`?thread=` → swap-on-attach): the kernel transcript becomes
 * the thread's, so the NEXT turn continues it (model continuity) and the
 * boundary is a real live-attach — NOT a read-only replay. Mirrors the
 * mount-connect arg shape: `auth` only rides when a token is present, so the
 * no-token path stays byte-identical to the legacy connect.
 */
export const buildResumeConnectOptions = (
  connection: { readonly url: string; readonly token?: string },
  resumeThreadId: string,
): ConnectOptions => ({
  url: connection.url,
  resumeThreadId,
  ...(connection.token !== undefined ? { auth: { token: connection.token } } : {}),
})

/**
 * P1 Phase 3b — ARM the daemon swap by re-dialing the WS carrying the thread.
 * Extracted from the resume effect so the wire — disconnect THEN connect with a
 * `?thread=` ConnectOptions — is directly testable (a fake client records the
 * call order), not buried in a React effect where a dropped re-dial would be
 * invisible to the suite. The disconnect-before-connect order matters: the
 * daemon only reads `?thread` at WS UPGRADE, so the swap requires a fresh
 * socket, not a mutation of the current one.
 */
export const armThreadSwapRedial = (
  client: Pick<SessionClient, "disconnect" | "connect">,
  connection: { readonly url: string; readonly token?: string },
  resumeThreadId: string,
): void => {
  client.disconnect()
  client.connect(buildResumeConnectOptions(connection, resumeThreadId))
}

const buildSlashContextSnapshot = (args: {
  readonly modelSlug: string | null
  readonly connection: ConnectionState
  readonly sessionId: string | null
  readonly sessionState: SessionStateView | null
  readonly messageCount: number
  readonly tokenUsage: CumulativeTokenUsage
  /** S3 — latest `context.usage` frame (or null) so `/context` can render the
   *  live segmented gauge. */
  readonly contextUsage: ContextUsageMessage | null
}): SlashCommandContext => ({
  modelSlug: args.modelSlug,
  connection: {
    kind: args.connection.kind,
    ...(args.connection.kind === "disconnected"
      ? { detail: `attempt ${args.connection.attempt}` }
      : args.connection.kind === "connecting" && args.connection.attempt > 0
        ? { detail: `attempt ${args.connection.attempt}` }
        : {}),
  },
  sessionId: args.sessionId,
  sessionStatus: args.sessionState?.status ?? null,
  permissionMode: args.sessionState?.permissionMode ?? null,
  identityMode: args.sessionState?.identityMode ?? null,
  toolProfile: args.sessionState?.toolProfile ?? null,
  messageCount: args.sessionState?.messageCount ?? args.messageCount,
  tokenUsage: args.tokenUsage,
  contextUsage: args.contextUsage,
})

export const App = (): JSX.Element => {
  const client = useMemo(() => new SessionClient(), [])
  const connection = useConnectionState(client)

  // WS-F move 2 — the ConnectionState machine. Folds the socket lifecycle,
  // the (now CAPPED) bootstrap-config retry loop, and transcript-hydration
  // outcomes into ONE state that drives the banner, the empty-state copy,
  // the composer enablement, and the failed-state retry CTA.
  const [uiConnection, dispatchUiConnection] = useReducer(
    transitionUiConnection,
    INITIAL_UI_CONNECTION,
  )
  useEffect(() => {
    dispatchUiConnection({ type: "socket-changed", socket: connection })
  }, [connection])
  // Bumping the epoch re-runs the bootstrap effect from attempt 0 (the
  // failed-banner "Retry" CTA).
  const [bootstrapEpoch, setBootstrapEpoch] = useState(0)
  const retryBootstrap = useCallback((): void => {
    dispatchUiConnection({ type: "retry-requested" })
    setBootstrapEpoch((e) => e + 1)
  }, [])
  const {
    messages,
    streamingMessageId,
    streamingText,
    streamingTimestamp,
    sessionState,
    resetTranscript,
    appendClientMessage,
    modelSlug,
    tokenUsage,
  } = useSessionEvents(client)
  const [learnedSessionId, setLearnedSessionId] = useState<string | null>(() => client.sessionId)
  useEffect(() => {
    const off = client.onSessionId(setLearnedSessionId)
    return off
  }, [client])
  const sendTurn = useSendTurn(client, learnedSessionId)
  // P2 (jul-11) — /retry-with reads the transcript at INVOKE time via a ref so
  // the slash-catalogue memo does not re-assemble on every message.
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // ADR-0512 P3 — live pending approvals (the escalation-card backing state).
  // The daemon enriches a skill-scope escalation's `approval.requested` event
  // with `scopeContext`; the card renders it and the user answers via
  // `approval.respond`. Empty when no approval is pending ⇒ no card rendered.
  const { approvals: pendingApprovals, dismiss: dismissApproval } = usePendingApprovals(client)
  const sendApprovalDecision = useSendApprovalDecision(client, learnedSessionId)
  const sendCancel = useSendCancel(client, learnedSessionId)
  const onSetPermission = useSendPermissionMode(client, learnedSessionId)
  // ADR-0540 W1-B — when the daemon declares the `serverAutoContinues`
  // capability marker, IT re-issues the post-approval `turn.run`; the client
  // must not (marker false / legacy daemon ⇒ client-owned continuation,
  // byte-identical legacy behavior).
  const serverAutoContinues = useServerAutoContinues(client)
  const onApprovalDecision = useCallback(
    (decision: EscalationDecision): void => {
      // Determine escalation-ness BEFORE the optimistic dismiss removes the
      // approval from the live set — an escalation carries `scopeContext`.
      const isEscalation =
        pendingApprovals.find((a) => a.approvalId === decision.approvalId)?.scopeContext !==
        undefined
      // ADR-0512 P3 — thread the escalation's once/session scope + steer so
      // allow_once (no widen) and deny_and_steer (corrective steer) take effect,
      // and RE-RUN the suspended turn (the kernel does not auto-continue) so the
      // approved tool actually dispatches / the recoverable decline is produced.
      // ADR-0540 W1-B — unless the DAEMON owns that re-run (capability marker).
      sendApprovalDecision(decision.approvalId, decision.decision, {
        ...(decision.scope !== undefined ? { scope: decision.scope } : {}),
        ...(decision.steer !== undefined ? { steer: decision.steer } : {}),
        continueTurn:
          !serverAutoContinues && shouldContinueAfterApproval(decision.decision, isEscalation),
      })
      // Optimistic: drop the card immediately; the authoritative
      // `approval.resolved` event then arrives and is a no-op for the dropped id.
      dismissApproval(decision.approvalId)
    },
    [pendingApprovals, sendApprovalDecision, dismissApproval, serverAutoContinues],
  )

  const [draft, setDraft] = useState("")
  const [knobsPanelOpen, setKnobsPanelOpen] = useState(false)
  const attachment = useImageAttachment()
  const [resolvedConnection, setResolvedConnection] = useState<{
    url: string
    token?: string
  } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Transcript hydration after page reload. The daemon persists every
  // SessionEvent to `~/.quanta/web-daemon/threads.db`; on first sight of
  // a sessionId we fetch the past events via `/threads/:id/events` and
  // replay them through the same dispatch path as live WS frames. The
  // reducer's eventId-set dedups any overlap with frames that may have
  // arrived between WS attach and HTTP response. We only hydrate once
  // per sessionId so reconnects within the same session don't re-load.
  const hydratedSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (learnedSessionId === null || resolvedConnection === null) return
    if (hydratedSessionIdRef.current === learnedSessionId) return
    hydratedSessionIdRef.current = learnedSessionId
    const ctrl = new AbortController()
    void hydrateTranscript({
      httpBase: httpUrlFromWsUrl(resolvedConnection.url),
      sessionId: learnedSessionId,
      ...(resolvedConnection.token !== undefined ? { token: resolvedConnection.token } : {}),
      fetchImpl: fetch,
      signal: ctrl.signal,
      replay: (events) => {
        client.replayEvents(events)
      },
    }).then((outcome) => {
      if (ctrl.signal.aborted) return
      if (!outcome.ok) {
        if (outcome.aborted === true) return
        // UUX-5-07 — FAIL LOUD: a hydrate failure degrades with a banner
        // (the pre-fix `if (!resp.ok) return` rendered a silently empty
        // transcript with zero UI).
        console.warn("quanta: transcript hydrate failed", outcome.reason)
        dispatchUiConnection({
          type: "hydrate-failed",
          reason: `history fetch failed (${outcome.reason})`,
        })
        return
      }
      dispatchUiConnection({ type: "hydrate-recovered" })
    })
    return () => {
      ctrl.abort()
    }
  }, [learnedSessionId, resolvedConnection, client])

  // B2 — cross-surface thread handoff RESUME. When the deeplink banner's "Open"
  // is clicked (or a `?thread=`/`quanta://threads/{id}` is present on load — see
  // ThreadDeeplinkBanner), `resumeThreadId` names a thread to OPEN. We drive the
  // daemon's thread-addressed `GET /threads/:id/events` hydration against THAT
  // id (not only the server-minted `learnedSessionId`) and replay its persisted
  // events into the transcript. HONEST BOUNDARY: the daemon runs one shared
  // live session (server-minted id), so this is a READ-ONLY HISTORY hydration —
  // new turns still advance the live session. When the requested id equals the
  // live id it is an effective live-attach. `resumeState` surfaces the
  // "resuming…" → "resumed" transition + the boundary to the UI.
  const [resumeThreadId, setResumeThreadId] = useState<string | null>(null)
  const [resumeState, setResumeState] = useState<ResumeUiState>({ phase: "idle" })
  const resumedThreadIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (resumeThreadId === null || resolvedConnection === null) return
    // Hydrate each requested thread at most once (a re-render must not re-fetch).
    if (resumedThreadIdRef.current === resumeThreadId) return
    resumedThreadIdRef.current = resumeThreadId
    const httpBase = httpUrlFromWsUrl(resolvedConnection.url)
    const ctrl = new AbortController()
    setResumeState({ phase: "resuming", threadId: resumeThreadId })
    // P1 Phase 3b — ARM THE DAEMON SWAP: re-dial the WS carrying
    // `resumeThreadId` so the daemon swaps its one live session onto this thread
    // (`?thread=` → swap-on-attach). This gives model continuity — the NEXT turn
    // continues the opened thread's kernel transcript — and flips the boundary to
    // a real live-attach. The REST hydration below still RENDERS the thread's
    // persisted transcript, because `transcript.replace` emits only a
    // `session.state.updated` summary, not the per-message events the UI draws.
    //
    // BOUNDARY RACE (honest-conservative): the REST /events call fires
    // concurrently with the WS re-dial+swap and usually lands first, so the
    // daemon's authoritative `boundary` may briefly report `read-only-history`
    // even though the swap is arming. We trust the SERVER value (thread-resume
    // prefers it), so we may under-report live→read-only but NEVER falsely claim
    // live — the safe direction. A crisp post-swap boundary needs the daemon to
    // signal the swap OUTCOME over the WS (scoped follow-up, see the plan).
    armThreadSwapRedial(client, resolvedConnection, resumeThreadId)
    void hydrateThreadResume({
      requestedThreadId: resumeThreadId,
      liveSessionId: learnedSessionId,
      httpBase,
      ...(resolvedConnection.token !== undefined ? { token: resolvedConnection.token } : {}),
      fetchImpl: fetch,
      signal: ctrl.signal,
    })
      .then((outcome) => {
        if (ctrl.signal.aborted) return
        if (!outcome.ok) {
          if (outcome.reason === "aborted") return
          console.warn("quanta: thread resume failed", outcome.reason)
          setResumeState({ phase: "failed", threadId: resumeThreadId })
          return
        }
        // Replay through the SAME fanout path as live frames; the reducer dedups
        // by eventId so any overlap with the live-session hydration is a no-op.
        client.replayEvents(outcome.result.events)
        setResumeState({
          phase: "resumed",
          threadId: resumeThreadId,
          boundary: outcome.result.boundary,
          count: outcome.result.events.length,
        })
      })
      .catch((error: unknown) => {
        // hydrateThreadResume never rejects (all failure paths are typed), but the
        // `.then` body itself (replay/setState) could throw — never leave that as
        // an unhandled rejection or a stuck "resuming…" banner.
        if (ctrl.signal.aborted) return
        console.warn("quanta: thread resume errored", error)
        setResumeState({ phase: "failed", threadId: resumeThreadId })
      })
    return () => {
      ctrl.abort()
    }
  }, [resumeThreadId, resolvedConnection, learnedSessionId, client])

  // Wire connect on mount / disconnect on unmount.
  // We also re-resolve on `quanta:config-ready` because Tauri may inject
  // `window.__QUANTA_CONFIG__` AFTER the React app first mounts (the inject
  // script runs once the main webview reports ready). If the event fires
  // before mount, the initial resolve already picked it up.
  // biome-ignore lint/correctness/useExhaustiveDependencies(bootstrapEpoch): intentional re-run trigger — the failed-banner Retry CTA bumps the epoch to restart the capped bootstrap loop from attempt 0.
  useEffect(() => {
    let cancelled = false
    let retryHandle: ReturnType<typeof setTimeout> | null = null
    let generation = 0
    // UUX-3-06 — the resolve-retry loop is CAPPED: after
    // BOOTSTRAP_MAX_ATTEMPTS failures (with backoff) the machine lands in
    // `failed` with a retry CTA instead of spinning "Connecting…" forever.
    let failedAttempts = 0

    const connectWithResolvedConfig = async (
      reason: "initial" | "config-ready" | "retry",
    ): Promise<void> => {
      const currentGeneration = ++generation
      try {
        const { url, token } = await resolveConnectionConfig()
        if (cancelled || currentGeneration !== generation) return
        failedAttempts = 0
        setResolvedConnection(token === undefined ? { url } : { url, token })
        if (reason !== "initial") {
          client.disconnect()
        }
        client.connect(token === undefined ? { url } : { url, auth: { token } })
      } catch (error) {
        if (cancelled || currentGeneration !== generation) return
        failedAttempts += 1
        console.warn(
          `quanta bootstrap config resolution failed (attempt ${failedAttempts}/${BOOTSTRAP_MAX_ATTEMPTS})`,
          error,
        )
        if (failedAttempts >= BOOTSTRAP_MAX_ATTEMPTS) {
          dispatchUiConnection({
            type: "bootstrap-gave-up",
            reason: `gave up after ${failedAttempts} attempts (${error instanceof Error ? error.message : String(error)})`,
          })
          return
        }
        dispatchUiConnection({ type: "bootstrap-attempt-failed", attempt: failedAttempts })
        retryHandle = setTimeout(
          () => {
            retryHandle = null
            void connectWithResolvedConfig("retry")
          },
          bootstrapRetryDelayMs(failedAttempts - 1),
        )
      }
    }

    void connectWithResolvedConfig("initial")
    const onConfigReady = (): void => {
      // Fresh config from the shell: reset the give-up budget and reconnect.
      failedAttempts = 0
      client.disconnect()
      void connectWithResolvedConfig("config-ready")
    }
    window.addEventListener("quanta:config-ready", onConfigReady)
    return () => {
      cancelled = true
      if (retryHandle !== null) clearTimeout(retryHandle)
      window.removeEventListener("quanta:config-ready", onConfigReady)
      client.disconnect()
    }
  }, [client, bootstrapEpoch])

  // UUX-3-05 — OS notification on turn completion while the user is away.
  // The presence decision is the EXISTING `computeWebPresence` (presence-probe,
  // previously zero call sites): hidden/backgrounded tab OR idle past the
  // activity window ⇒ fire a browser Notification on `turn.completed`.
  // Permission-gated; degrades silently when denied / unavailable.
  useEffect(() => {
    return installTurnCompleteNotifyBrowser((handler) => client.onAny(handler))
  }, [client])

  // Hotkey toast → append to draft + focus (legacy OCR text path).
  useEffect(() => {
    const handler = (ev: MessageEvent<unknown>) => {
      if (!isHotkeyCapturePayload(ev.data)) return
      const stamp = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
      const piece = `[Screen captured at ${stamp}] ${ev.data.text}`
      setDraft((prev) => (prev.length === 0 ? piece : `${prev}\n${piece}`))
      inputRef.current?.focus()
    }
    window.addEventListener("message", handler)
    return () => {
      window.removeEventListener("message", handler)
    }
  }, [])

  // Active-monitor image capture (Cmd+Ctrl+Shift+[): hand off to the
  // composer hook so MIME / size validation matches the picker/paste paths.
  useEffect(() => {
    const handler = (ev: MessageEvent<unknown>) => {
      if (!isHotkeyImagePayload(ev.data)) return
      attachment.attachFromHotkey(ev.data)
      inputRef.current?.focus()
    }
    window.addEventListener("message", handler)
    return () => {
      window.removeEventListener("message", handler)
    }
  }, [attachment.attachFromHotkey])

  // Send-trigger hotkey (Cmd+Ctrl+Shift+]): equivalent to pressing Enter
  // on the composer — submits the current draft + any pending image.
  // When draft is empty AND images are attached, auto-fill the standard
  // image-analysis prompt so the capture→send flow needs only the hotkey.
  // Uses refs so the listener (registered once) always sees the latest
  // draft/submit/pending-image state. (`draftRef` itself is declared above —
  // the slash-outcome guard shares it.)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  const pendingImageCountRef = useRef(0)
  useEffect(() => {
    pendingImageCountRef.current = attachment.pendingImages.length
  }, [attachment.pendingImages.length])
  const submitRef = useRef<(text: string) => void>(() => undefined)
  useEffect(() => {
    const handler = (ev: MessageEvent<unknown>) => {
      if (!isHotkeySendPayload(ev.data)) return
      const trimmed = draftRef.current.trim()
      const text =
        trimmed.length === 0 && pendingImageCountRef.current > 0
          ? HOTKEY_SEND_IMAGE_PROMPT
          : trimmed
      submitRef.current(text)
    }
    window.addEventListener("message", handler)
    return () => {
      window.removeEventListener("message", handler)
    }
  }, [])

  const attachImageFile = useCallback(
    async (
      file: File,
      source: import("./composer/image-attachment").FileAttachmentSource,
    ): Promise<void> => {
      await attachment.attachFile(file, source)
      inputRef.current?.focus()
    },
    [attachment.attachFile],
  )

  // Held by ref so `submit` (declared before `slashCommands`) can route a
  // leading-`/` draft to the matching slash entry instead of shoving the
  // literal "/login" string into a turn — the latter is what burned us
  // before: the slash action ran AND the LLM saw "/login" as a prompt,
  // triggering a stale-token `/models` call.
  const slashCommandsRef = useRef<readonly SlashCommand[]>([])
  // Latest draft, for the async slash-outcome guard below.
  const draftRef = useRef("")

  /**
   * WS-F move 1 — apply a routed slash outcome. This is the OTHER half of the
   * `executeSlashCommand` contract: the action's returned draft is APPLIED
   * (the pre-fix submit path discarded it — UUX-2-01), a `sent` outcome goes
   * to the session, and an `unwired` hint lands in the transcript with the
   * draft KEPT.
   */
  const applySlashOutcome = useCallback(
    (outcome: SlashAcceptOutcome, draftAtInvoke: string): void => {
      switch (outcome.kind) {
        case "draft":
          // Guard the async gap (e.g. a readout fetch): if the user typed a
          // NEW draft while the action ran, a bare "clear" must not eat it.
          if (outcome.nextDraft !== "" || draftRef.current === draftAtInvoke) {
            setDraft(outcome.nextDraft)
          }
          return
        case "sent":
          // Adversarial case: a `server-slash` accepted from the palette
          // while the socket is down / no session yet — `sendTurn` would
          // silently drop it. Explain and keep the draft instead.
          if (connection.kind !== "connected" || learnedSessionId === null) {
            appendClientMessage(
              "error",
              `not connected — "${outcome.text}" was not sent; your draft was kept`,
            )
            return
          }
          sendTurn(outcome.text, attachment.toImageBlocks())
          setDraft("")
          attachment.clear()
          return
        case "hint":
          appendClientMessage("system", outcome.hint)
          return // draft intentionally kept
      }
    },
    [
      appendClientMessage,
      attachment.clear,
      attachment.toImageBlocks,
      connection.kind,
      learnedSessionId,
      sendTurn,
    ],
  )

  /** Route one accepted slash entry through the single execution choke point.
   *  Shared by the palette accept (ChatPanel → onSlashAccept) and the
   *  composer submit path below. */
  const runSlashCommand = useCallback(
    (cmd: SlashCommand, rest: string): void => {
      const draftAtInvoke = draftRef.current
      executeSlashCommand(cmd, rest, draftAtInvoke)
        .then((outcome) => {
          applySlashOutcome(outcome, draftAtInvoke)
        })
        .catch((error: unknown) => {
          // A throwing action must never strand the user silently.
          appendClientMessage(
            "error",
            `/${cmd.slug} failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    },
    [applySlashOutcome, appendClientMessage],
  )

  const submit = useCallback(
    (text: string): void => {
      if (connection.kind !== "connected") return
      const trimmed = text.trim()
      if (trimmed.length === 0 && attachment.pendingImages.length === 0) return
      const slash = resolveSlashCommandFrom(slashCommandsRef.current, trimmed)
      if (slash !== null) {
        runSlashCommand(slash.cmd, slash.rest)
        return
      }
      sendTurn(trimmed, attachment.toImageBlocks())
      setDraft("")
      attachment.clear()
    },
    [
      attachment.clear,
      attachment.pendingImages.length,
      attachment.toImageBlocks,
      connection.kind,
      runSlashCommand,
      sendTurn,
    ],
  )
  // Keep submitRef in sync with the latest `submit` closure so the
  // send-trigger hotkey listener can call into current state.
  useEffect(() => {
    submitRef.current = submit
  }, [submit])

  // Composer enablement derives from the ConnectionState machine (a `failed`
  // bootstrap disables it even before any socket exists) AND the live socket
  // + session-id preconditions for actually sending.
  const inputDisabled =
    !composerEnabled(uiConnection) || connection.kind !== "connected" || learnedSessionId === null

  // ADR-0448 (RFC-10) / ADR-0440 / A2: the canvas WS channel — the rich
  // context-usage breakdown (`useContextUsage`), the per-tool DiffPanels
  // (`useToolDiffs`) and the ready-artifact strip (`useArtifacts`). Mounted
  // HERE (above the slash-context ref) so the live `context.usage` frame is also
  // available to the `/context` slash gauge (S3). Default-OFF: with no canvas
  // frames (no `QUANTA_WEB_CANVAS=1`) the source never fires — `contextUsage`
  // stays `null`, `toolDiffs` / `artifacts` stay empty, and every consumer
  // self-hides (chat UI byte-identical).
  const canvasSource = useMemo<CanvasSource>(
    () => ({
      subscribe: (handler) => client.onCanvas(handler),
    }),
    [client],
  )
  const contextUsage = useContextUsage(canvasSource)
  const toolDiffs = useToolDiffs(canvasSource)
  // A2 — `artifact.ready` frames off the SAME canvas channel. `useArtifacts`
  // collects them latest-wins per id; the `ArtifactStrip` in the pane renders a
  // per-kind preview/download card. Default-OFF: no canvas frames ⇒ empty Map ⇒
  // strip self-hides (byte-identical).
  const artifacts = useArtifacts(canvasSource)

  const slashContextRef = useRef<SlashCommandContext>(
    buildSlashContextSnapshot({
      modelSlug,
      connection,
      sessionId: learnedSessionId,
      sessionState,
      messageCount: messages.length,
      tokenUsage,
      contextUsage,
    }),
  )
  useEffect(() => {
    slashContextRef.current = buildSlashContextSnapshot({
      modelSlug,
      connection,
      sessionId: learnedSessionId,
      sessionState,
      messageCount: messages.length,
      tokenUsage,
      contextUsage,
    })
  }, [
    modelSlug,
    connection,
    learnedSessionId,
    sessionState,
    messages.length,
    tokenUsage,
    contextUsage,
  ])
  const getSlashContext = useCallback((): SlashCommandContext => {
    return slashContextRef.current
  }, [])
  const focusImageAttachment = useCallback((): void => {
    inputRef.current?.focus()
  }, [])
  const openKnobsPanel = useCallback((): void => {
    setKnobsPanelOpen(true)
  }, [])
  const closeKnobsPanel = useCallback((): void => {
    setKnobsPanelOpen(false)
  }, [])

  // Daemon endpoint for the Knobs panel (GET /api/knobs + POST /config).
  // Derived from the resolved WS URL — same host/port, http scheme. `null`
  // until the first daemon-info round-trip completes.
  const knobsEndpoint = useMemo<KnobsEndpoint | null>(() => {
    if (resolvedConnection === null) return null
    return {
      httpUrl: httpUrlFromWsUrl(resolvedConnection.url),
      ...(resolvedConnection.token !== undefined ? { token: resolvedConnection.token } : {}),
    }
  }, [resolvedConnection])

  // Slash command catalogue — assembled by the SAME pure function the palette
  // invariant test exercises (slash-catalog.ts): base entries plus, once the
  // daemon endpoint resolves, the HTTP-backed llm-config / auth / readout
  // commands (which REPLACE the unwired stubs whose slugs they own).
  const slashCommands = useMemo(
    () =>
      assembleSlashCommands({
        clearTranscript: resetTranscript,
        focusImageAttachment,
        appendClientMessage,
        getContext: getSlashContext,
        openKnobsPanel,
        retryWith: {
          getMessages: () => messagesRef.current,
          sendUserTurn: (text: string) => sendTurn(text, []),
        },
        endpoint:
          resolvedConnection === null
            ? null
            : {
                httpUrl: httpUrlFromWsUrl(resolvedConnection.url),
                ...(resolvedConnection.token !== undefined
                  ? { token: resolvedConnection.token }
                  : {}),
              },
      }),
    [
      resetTranscript,
      focusImageAttachment,
      resolvedConnection,
      appendClientMessage,
      getSlashContext,
      openKnobsPanel,
      sendTurn,
    ],
  )

  // Keep the ref in sync so `submit`'s slash-routing path sees the latest
  // command set (esp. when `resolvedConnection` becomes non-null after the
  // first daemon-info round-trip and the auth/llm commands appear).
  useEffect(() => {
    slashCommandsRef.current = slashCommands
  }, [slashCommands])

  const canRestartDaemon = readTauriInvoke() !== undefined
  const resolvedModel =
    modelSlug ?? (import.meta.env.VITE_QUANTA_MODEL as string | undefined) ?? "gpt-5"

  const observabilitySource = useMemo<ObservabilitySource>(
    () => ({
      subscribe: (handler) => client.onObservability(handler),
    }),
    [client],
  )
  const observability = useObservabilityState(observabilitySource)

  // QUANTA_WEB_AGENT_STATE — the out-of-band agent-state channel (the 9 events
  // the in-band session protocol DROPS: plan.* / mode.changed / tool.progress /
  // context.compacted / ratelimit.snapshot). Mirrors `canvasSource` above —
  // wraps `client.onAgentState`. With the daemon gate OFF (no
  // `QUANTA_WEB_AGENT_STATE=1`) no `agentState` frame ever decodes, the source
  // never fires, and `agentState` stays the EMPTY view ⇒ `PlanPanel` +
  // `AgentStatePanel` both self-hide (chat UI byte-identical, default-OFF).
  // A fan-out hub over `client.onAgentState`: the hook subscribes here, and
  // `inject` lets the App push a SYNTHETIC frame (the optimistic `plan.input.
  // resolved` after answering) into the SAME fold path so the prompt card clears
  // instantly — the daemon's real resolve frame arrives moments later and is an
  // idempotent no-op (the reducer ignores a resolve whose promptId no longer
  // matches an outstanding prompt).
  const agentStateHub = useMemo(() => {
    const handlers = new Set<(msg: AgentStateMessage) => void>()
    let detachClient: (() => void) | null = null
    const source: AgentStateSource = {
      subscribe: (handler) => {
        handlers.add(handler)
        // Lazily bridge the client on the first subscriber.
        if (detachClient === null) {
          detachClient = client.onAgentState((msg) => {
            for (const h of [...handlers]) h(msg)
          })
        }
        return () => {
          handlers.delete(handler)
        }
      },
    }
    const inject = (msg: AgentStateMessage): void => {
      for (const h of [...handlers]) h(msg)
    }
    return { source, inject }
  }, [client])
  // UUX-5-15 — completion cleanup for the tool-progress rows: the session
  // channel's `tool.completed` events (which carry `toolCallId`) clear the
  // finished tool's progress line instead of leaving it until FIFO eviction.
  const toolCompletionSource = useMemo(
    () => ({
      subscribe: (handler: (toolCallId: string) => void) =>
        client.onAny((event) => {
          if (event.type === "tool.completed") handler(event.toolCallId)
        }),
    }),
    [client],
  )
  const agentState = useAgentState(agentStateHub.source, toolCompletionSource)

  // S2 (T01) — the `item.*` fine-grained item stream rides the SAME agent-state
  // channel (the in-band session transcript drops it). `useItemStream` folds the
  // frames into subagent-activity rows the `ItemStreamSection` renders. Gated by
  // `QUANTA_ITEM_STREAM` at the daemon: OFF ⇒ no `item.*` frame ever decodes ⇒
  // empty state ⇒ the section self-hides (byte-identical).
  const itemStream = useItemStream(agentStateHub.source)

  // QUANTA_WEB_SUBAGENTS — the Sub-Agents panel channel. A fan-out hub over
  // `client.onSubagent` (mirror of `agentStateHub`, minus `inject` — subagent
  // frames are a live stream, never synthetically injected). Daemon gate OFF ⇒
  // no `subagent` frame decodes ⇒ the source never fires ⇒ `subagents` stays the
  // EMPTY view ⇒ `SubAgentsPanel` self-hides (chat UI byte-identical).
  const subagentSource = useMemo<SubagentSource>(() => {
    const handlers = new Set<(msg: SubagentMessage) => void>()
    let detachClient: (() => void) | null = null
    return {
      subscribe: (handler) => {
        handlers.add(handler)
        if (detachClient === null) {
          detachClient = client.onSubagent((msg) => {
            for (const h of [...handlers]) h(msg)
          })
        }
        return () => {
          handlers.delete(handler)
          // Tear down the underlying client bridge when the last subscriber
          // leaves (no dangling `onSubagent` subscription if this memo re-runs).
          if (handlers.size === 0 && detachClient !== null) {
            detachClient()
            detachClient = null
          }
        }
      },
    }
  }, [client])
  const subagents = useSubagentState(subagentSource)

  // QUANTA_WEB_AGENT_STATE — close the OUT-OF-BAND INBOUND loop: a WEB user
  // answers (or cancels) the paused agent's `request_user_input` prompt. Sends
  // the raw `planInputAnswer` frame (NOT a SessionCommand) + optimistically
  // clears the prompt card via a synthetic resolve so the UI does not wait on the
  // round-trip.
  const onPlanInputAnswer = useCallback(
    (promptId: string, outcome: PlanInputAnswer) => {
      client.sendPlanInputAnswer(promptId, outcome)
      const emittedAt = Date.now()
      agentStateHub.inject(
        outcome.decision === "answer"
          ? {
              kind: "plan.input.resolved",
              promptId,
              decision: "answer",
              text: outcome.text,
              emittedAt,
            }
          : { kind: "plan.input.resolved", promptId, decision: "cancelled", emittedAt },
      )
    },
    [client, agentStateHub],
  )

  // Codex-like: the sidebar stays OFF-screen until there's actually something to
  // show. Empty (no runs / objective / approvals / usage / diffs / agent-state)
  // ⇒ the chat takes the full width instead of a permanent empty pane. A live
  // plan OR any agent-state axis (mode / tool-progress / compaction / ratelimit /
  // plan-prompt) ALSO opens the sidebar so the agent-state column is never
  // rendered into a collapsed pane.
  const hasAgentState =
    agentState.plan !== null || agentStateHasContent(agentState) || subagentHasContent(subagents)
  const hasObservabilityData = computeHasObservabilityData(
    observability,
    contextUsage,
    toolDiffs.size > 0,
    hasAgentState,
    artifacts.size > 0 || itemStream.items.size > 0,
  )

  return (
    <div className="flex h-full min-h-screen flex-col bg-surface text-ink">
      <SessionChrome
        connection={connection}
        model={resolvedModel}
        resolvedConnection={resolvedConnection}
        sessionState={sessionState ?? null}
        tokenUsage={tokenUsage}
        canRestartDaemon={canRestartDaemon}
        onCancel={sendCancel}
        onSetPermission={onSetPermission}
        contextUsage={contextUsage}
      />
      {/* B2 — thread deeplink affordance + RESUME. Reads `?thread=`/`#thread=`
          (or a Tauri-forwarded `quanta://threads/{id}` postMessage) on load and
          shows which thread was requested. Clicking "Open" wires `onOpen` →
          `setResumeThreadId`, which drives a READ-ONLY HISTORY hydration of that
          thread via the daemon's `/threads/:id/events` route (the live session id
          is server-minted; new turns advance the live shared session — see the
          resume effect above). `resumeState` surfaces the honest boundary. */}
      <ThreadDeeplinkBanner onOpen={setResumeThreadId} />
      {/* UUX-4-06 (D-10) — thread list over the daemon's GET /threads route.
          Collapsed toggle; expanding fetches the persisted thread list and each
          row's Open routes through the SAME resume path as the deeplink banner
          (`setResumeThreadId` → read-only history hydration above). The live
          shared-session row is badged so the boundary stays honest. */}
      <ThreadPicker
        endpoint={knobsEndpoint}
        onOpen={setResumeThreadId}
        liveSessionId={learnedSessionId}
      />
      {/* WS-F move 2 — connection banner (mirrors the resume-status banner
          chrome): `degraded` explains a partial failure (e.g. history hydrate
          — UUX-5-07); `failed` explains the capped bootstrap give-up
          (UUX-3-06) and offers the retry CTA. */}
      {(() => {
        const banner = connectionBanner(uiConnection)
        if (banner === null) return null
        return (
          <div
            className="flex items-center gap-2 border-b border-line-subtle bg-surface-raised px-4 py-1.5 text-xs text-ink-muted"
            role="status"
            data-testid="connection-status-banner"
          >
            <span>{banner.text}</span>
            {banner.retry ? (
              <button
                type="button"
                onClick={retryBootstrap}
                className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink transition hover:bg-black/[0.05]"
                data-testid="connection-retry"
              >
                Retry
              </button>
            ) : null}
          </div>
        )
      })()}
      {formatResumeStatus(resumeState) !== null ? (
        <div
          className="flex items-center gap-2 border-b border-line-subtle bg-surface-raised px-4 py-1.5 text-xs text-ink-muted"
          role="status"
          data-testid="thread-resume-status"
        >
          <span>{formatResumeStatus(resumeState)}</span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-row">
        <ChatPanel
          messages={messages}
          streamingMessageId={streamingMessageId}
          streamingText={streamingText}
          streamingTimestamp={streamingTimestamp}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          inputRef={inputRef}
          disabled={inputDisabled}
          pendingImages={attachment.pendingImages}
          attachmentError={attachment.attachmentError}
          onAttachImageFile={attachImageFile}
          onRemovePendingImage={attachment.removeAt}
          onClearAllPendingImages={attachment.clear}
          sessionStatus={sessionState?.status ?? null}
          slashCommands={slashCommands}
          onSlashAccept={runSlashCommand}
          pendingApprovals={pendingApprovals}
          onApprovalDecision={onApprovalDecision}
          connectionPhase={uiConnection.phase}
        />
        {hasObservabilityData ? (
          <>
            {/* QUANTA_WEB_AGENT_STATE — the agent-state axes the in-band session
                protocol drops (plan / mode / tool-progress / compaction /
                ratelimit). Its own narrow column LEFT of the observability pane.
                Both panels self-hide on the empty view, so when the daemon gate
                is OFF they render nothing — and the column is suppressed entirely
                unless there is a plan or some agent-state axis to show (chat
                byte-identical). */}
            {hasAgentState ? (
              <aside
                aria-label="agent state"
                data-testid="agent-state-column"
                className="flex w-72 flex-shrink-0 flex-col gap-3 overflow-y-auto border-l border-line-subtle bg-surface-raised px-3 py-4"
              >
                <PlanPanel plan={agentState.plan} />
                <AgentStatePanel state={agentState} onAnswer={onPlanInputAnswer} />
                <SubAgentsPanel state={subagents} />
              </aside>
            ) : null}
            <ObservabilityPane
              state={observability}
              usage={contextUsage}
              diffs={toolDiffs}
              artifacts={artifacts}
              itemStream={itemStream}
            />
          </>
        ) : null}
      </div>
      <HotkeyToast />
      {knobsPanelOpen ? <KnobsPanel endpoint={knobsEndpoint} onClose={closeKnobsPanel} /> : null}
    </div>
  )
}

const SessionChrome = memo(
  ({
    connection,
    model,
    resolvedConnection,
    sessionState,
    tokenUsage,
    canRestartDaemon,
    onCancel,
    onSetPermission,
    contextUsage,
  }: SessionChromeProps): JSX.Element => {
    return (
      <>
        {resolvedConnection !== null ? (
          <div className="flex items-center justify-end border-b border-line-subtle bg-surface px-4 py-1.5">
            <ConnectionUrlPill
              url={resolvedConnection.url}
              {...(resolvedConnection.token !== undefined
                ? { token: resolvedConnection.token }
                : {})}
            />
          </div>
        ) : null}
        <header className="flex items-center justify-between gap-3 border-b border-line-subtle px-4 py-2">
          <HeaderTitle model={model} />
          <div className="flex items-center gap-2">
            <PortBadge
              wsUrl={resolvedConnection?.url ?? null}
              connected={connection.kind === "connected"}
            />
            <TokenCounter usage={tokenUsage} />
            <ModeBadge
              state={sessionState}
              {...(onSetPermission !== undefined ? { onSetPermission } : {})}
            />
            <StatusBar
              connection={connection}
              sessionStatus={sessionState?.status ?? null}
              contextUsage={contextUsage}
              {...(canRestartDaemon ? { onRestartDaemon: restartDaemonViaTauri } : {})}
              {...(onCancel !== undefined ? { onCancel } : {})}
            />
          </div>
        </header>
      </>
    )
  },
)

interface HotkeySendPayload {
  readonly kind: "quanta:hotkey-send"
  readonly triggeredAtMs: number
}

const isHotkeySendPayload = (value: unknown): value is HotkeySendPayload => {
  if (value === null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return obj.kind === "quanta:hotkey-send" && typeof obj.triggeredAtMs === "number"
}

interface HotkeyCapturePayload {
  readonly kind: "quanta:hotkey-capture"
  readonly text: string
}

const isHotkeyCapturePayload = (value: unknown): value is HotkeyCapturePayload => {
  if (value === null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return obj.kind === "quanta:hotkey-capture" && typeof obj.text === "string"
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

const readTauriInvoke = (): TauriInvoke | undefined => {
  if (typeof window === "undefined") return undefined
  const candidate = (
    window as unknown as {
      __TAURI_INTERNALS__?: { invoke?: TauriInvoke }
    }
  ).__TAURI_INTERNALS__?.invoke
  return typeof candidate === "function" ? candidate : undefined
}

const restartDaemonViaTauri = async (): Promise<void> => {
  const invoke = readTauriInvoke()
  if (invoke === undefined) {
    throw new Error("tauri invoke unavailable")
  }
  // Rust's `restart_daemon` returns the new DaemonInfo AND emits a
  // `quanta:config-ready` event via webview eval. App.tsx's mount-effect
  // already listens for that event and reconnects, so we just wait for the
  // RPC to settle here.
  await invoke("restart_daemon")
}

const resolveTauriDaemonInfo = async (invoke: TauriInvoke): Promise<DaemonInfoPayload> => {
  let lastError: unknown = null
  let startAttempted = false

  for (let attempt = 0; attempt < TAURI_BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
    try {
      const value = await invoke("daemon_info")
      return normalizeDaemonInfo(value)
    } catch (error) {
      lastError = error
      const code = getTauriErrorCode(error)
      if (code !== "daemon-not-running") break
      if (!startAttempted) {
        startAttempted = true
        try {
          const value = await invoke("start_daemon")
          return normalizeDaemonInfo(value)
        } catch (startError) {
          lastError = startError
          const startCode = getTauriErrorCode(startError)
          if (startCode !== "daemon-already-running" && startCode !== "daemon-not-running") {
            throw startError
          }
        }
      }
      await sleep(TAURI_BOOTSTRAP_RETRY_MS)
    }
  }

  throw lastError ?? new Error("daemon_info bootstrap failed")
}

const normalizeDaemonInfo = (value: unknown): DaemonInfoPayload => {
  if (value === null || typeof value !== "object") {
    throw new Error("daemon_info returned a non-object payload")
  }
  const obj = value as Record<string, unknown>
  const wsUrl = firstString(obj.wsUrl, obj.ws_url)
  if (wsUrl === undefined) {
    throw new Error("daemon_info payload missing wsUrl/ws_url")
  }
  const authToken = firstString(obj.authToken, obj.auth_token)
  return authToken === undefined ? { wsUrl } : { wsUrl, authToken }
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

const getTauriErrorCode = (error: unknown): string | undefined => {
  if (error === null || typeof error !== "object") return undefined
  const obj = error as TauriInvokeError
  return typeof obj.code === "string" ? obj.code : undefined
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
