import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import {
  buildDefaultSlashCommands,
  isSlashMode,
  type SlashCommand,
  type SlashCommandContext,
  splitDraft,
} from "./components/SlashPalette"
import { StatusBar } from "./components/StatusBar"
import { buildAuthSlashCommands } from "./components/slash-auth"
import type { KnobsEndpoint } from "./components/slash-knobs"
import { buildLlmConfigSlashCommands, httpUrlFromWsUrl } from "./components/slash-llm-config"
import { buildReadoutSlashCommands, READOUT_SLUGS } from "./components/slash-readout"
import { TokenCounter } from "./components/TokenCounter"
import { isHotkeyImagePayload, type PendingImageAttachment } from "./composer/image-attachment"
import { useImageAttachment } from "./composer/use-image-attachment"
import type {
  AgentStateMessage,
  ConnectionState,
  ContextUsageMessage,
  SessionEvent,
  SessionStateView,
} from "./types/protocol"
import { type AgentStateSource, useAgentState } from "./ws/agent-state-hooks"
import { type CanvasSource, useContextUsage, useToolDiffs } from "./ws/canvas-hooks"
import { SessionClient } from "./ws/client"
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
  useSessionEvents,
} from "./ws/session-hooks"

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
): boolean =>
  observability.runs.length > 0 ||
  observability.objective !== null ||
  observability.approvals.length > 0 ||
  contextUsage !== null ||
  hasDiffs ||
  hasAgentState

const buildSlashContextSnapshot = (args: {
  readonly modelSlug: string | null
  readonly connection: ConnectionState
  readonly sessionId: string | null
  readonly sessionState: SessionStateView | null
  readonly messageCount: number
  readonly tokenUsage: CumulativeTokenUsage
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
})

export const App = (): JSX.Element => {
  const client = useMemo(() => new SessionClient(), [])
  const connection = useConnectionState(client)
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

  // ADR-0512 P3 — live pending approvals (the escalation-card backing state).
  // The daemon enriches a skill-scope escalation's `approval.requested` event
  // with `scopeContext`; the card renders it and the user answers via
  // `approval.respond`. Empty when no approval is pending ⇒ no card rendered.
  const { approvals: pendingApprovals, dismiss: dismissApproval } = usePendingApprovals(client)
  const sendApprovalDecision = useSendApprovalDecision(client, learnedSessionId)
  const sendCancel = useSendCancel(client, learnedSessionId)
  const onSetPermission = useSendPermissionMode(client, learnedSessionId)
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
      sendApprovalDecision(decision.approvalId, decision.decision, {
        ...(decision.scope !== undefined ? { scope: decision.scope } : {}),
        ...(decision.steer !== undefined ? { steer: decision.steer } : {}),
        continueTurn: shouldContinueAfterApproval(decision.decision, isEscalation),
      })
      // Optimistic: drop the card immediately; the authoritative
      // `approval.resolved` event then arrives and is a no-op for the dropped id.
      dismissApproval(decision.approvalId)
    },
    [pendingApprovals, sendApprovalDecision, dismissApproval],
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
    const httpBase = httpUrlFromWsUrl(resolvedConnection.url).replace(/\/$/, "")
    const fetchUrl = `${httpBase}/threads/${encodeURIComponent(learnedSessionId)}/events`
    const headers: Record<string, string> = {}
    if (resolvedConnection.token !== undefined) {
      headers.Authorization = `Bearer ${resolvedConnection.token}`
    }
    const ctrl = new AbortController()
    fetch(fetchUrl, { headers, signal: ctrl.signal })
      .then(async (resp) => {
        if (!resp.ok) return
        const body = (await resp.json()) as { events?: readonly SessionEvent[] }
        if (Array.isArray(body.events) && body.events.length > 0) {
          client.replayEvents(body.events)
        }
      })
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === "AbortError") return
        console.warn("quanta: transcript hydrate failed", error)
      })
    return () => {
      ctrl.abort()
    }
  }, [learnedSessionId, resolvedConnection, client])

  // Wire connect on mount / disconnect on unmount.
  // We also re-resolve on `quanta:config-ready` because Tauri may inject
  // `window.__QUANTA_CONFIG__` AFTER the React app first mounts (the inject
  // script runs once the main webview reports ready). If the event fires
  // before mount, the initial resolve already picked it up.
  useEffect(() => {
    let cancelled = false
    let retryHandle: ReturnType<typeof setTimeout> | null = null
    let generation = 0

    const connectWithResolvedConfig = async (
      reason: "initial" | "config-ready" | "retry",
    ): Promise<void> => {
      const currentGeneration = ++generation
      try {
        const { url, token } = await resolveConnectionConfig()
        if (cancelled || currentGeneration !== generation) return
        setResolvedConnection(token === undefined ? { url } : { url, token })
        if (reason !== "initial") {
          client.disconnect()
        }
        client.connect(token === undefined ? { url } : { url, auth: { token } })
      } catch (error) {
        if (cancelled || currentGeneration !== generation) return
        console.warn("quanta bootstrap config resolution failed", error)
        retryHandle = setTimeout(() => {
          retryHandle = null
          void connectWithResolvedConfig("retry")
        }, TAURI_BOOTSTRAP_RETRY_MS)
      }
    }

    void connectWithResolvedConfig("initial")
    const onConfigReady = (): void => {
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
  // draft/submit/pending-image state.
  const draftRef = useRef(draft)
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
    async (file: File, source: "picker" | "paste"): Promise<void> => {
      await attachment.attachFile(file, source)
      inputRef.current?.focus()
    },
    [attachment.attachFile],
  )

  // Held by ref so `submit` (declared before `slashCommands`) can route a
  // leading-`/` draft to the matching client-side slash action instead of
  // shoving the literal "/login" string into a turn — the latter is what
  // burned us before: the slash action ran AND the LLM saw "/login" as a
  // prompt, triggering a stale-token `/models` call.
  const slashCommandsRef = useRef<readonly SlashCommand[]>([])

  const resolveSlashCommand = useCallback(
    (text: string): { cmd: SlashCommand; rest: string } | null => {
      if (!isSlashMode(text)) return null
      const { slug, rest } = splitDraft(text)
      const list = slashCommandsRef.current
      const cmd =
        list.find((c) => c.slug.toLowerCase() === slug) ??
        list.find((c) => c.aliases?.some((a) => a.toLowerCase() === slug))
      return cmd === undefined ? null : { cmd, rest }
    },
    [],
  )

  const submit = useCallback(
    (text: string): void => {
      if (connection.kind !== "connected") return
      const trimmed = text.trim()
      if (trimmed.length === 0 && attachment.pendingImages.length === 0) return
      const slash = resolveSlashCommand(trimmed)
      if (slash !== null) {
        // Run the slash action, clear draft, and DO NOT send a turn. The
        // action may itself append a system message via `appendClientMessage`
        // (e.g. "browser opened — finish the ChatGPT login flow"). Its
        // string return value (legacy SlashPalette `onAccept` payload) is
        // ignored here — only the palette path uses it.
        void Promise.resolve(slash.cmd.action(slash.rest))
        setDraft("")
        attachment.clear()
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
      resolveSlashCommand,
      sendTurn,
    ],
  )
  // Keep submitRef in sync with the latest `submit` closure so the
  // send-trigger hotkey listener can call into current state.
  useEffect(() => {
    submitRef.current = submit
  }, [submit])

  const inputDisabled = connection.kind !== "connected" || learnedSessionId === null

  const slashContextRef = useRef<SlashCommandContext>(
    buildSlashContextSnapshot({
      modelSlug,
      connection,
      sessionId: learnedSessionId,
      sessionState,
      messageCount: messages.length,
      tokenUsage,
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
    })
  }, [modelSlug, connection, learnedSessionId, sessionState, messages.length, tokenUsage])
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

  // Slash command catalogue (frontend-only commands). Pass into ChatPanel
  // so the floating SlashPalette renders above InputBar when draft starts
  // with `/`. Server-side `/<cmd>` routing is out of scope for v1.
  const slashCommands = useMemo(() => {
    const base = buildDefaultSlashCommands({
      clearTranscript: resetTranscript,
      focusImageAttachment,
      appendClientMessage,
      getContext: getSlashContext,
      openKnobsPanel,
    })
    if (resolvedConnection === null) return base
    const sharedEndpoint = {
      httpUrl: httpUrlFromWsUrl(resolvedConnection.url),
      ...(resolvedConnection.token !== undefined ? { token: resolvedConnection.token } : {}),
      onResult: (msg: string, kind: "ok" | "err"): void => {
        appendClientMessage(kind === "err" ? "error" : "system", msg)
      },
    }
    const llmCommands = buildLlmConfigSlashCommands(sharedEndpoint)
    const authCommands = buildAuthSlashCommands(sharedEndpoint)
    // Phase 1 (jun-9-cli-web-parity ticket 05) — the read-only readouts fetch
    // GET /readout/:name (out-of-band, lease-free) and append the text to the
    // transcript. They REPLACE the old prefill stubs for these slugs:
    // `resolveSlashCommand` is first-match, so the prefill rows must be filtered
    // out of `base` or they'd shadow the live readout.
    const readoutCommands = buildReadoutSlashCommands({
      httpUrl: httpUrlFromWsUrl(resolvedConnection.url),
      ...(resolvedConnection.token !== undefined ? { token: resolvedConnection.token } : {}),
      appendSystem: (text: string): void => {
        appendClientMessage("system", text)
      },
      onError: (msg: string): void => {
        appendClientMessage("error", msg)
      },
    })
    const readoutSlugs = new Set<string>(READOUT_SLUGS)
    const baseMinusReadouts = base.filter((c) => !readoutSlugs.has(c.slug))
    return [...baseMinusReadouts, ...llmCommands, ...authCommands, ...readoutCommands]
  }, [
    resetTranscript,
    focusImageAttachment,
    resolvedConnection,
    appendClientMessage,
    getSlashContext,
    openKnobsPanel,
  ])

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

  // ADR-0448 (RFC-10): mount point for the rich context-usage breakdown +
  // (ADR-0440) the per-tool DiffPanels, both backed by the canvas WS channel.
  // Mirrors `observabilitySource` above — wraps `client.onCanvas`. Both
  // `context.usage` frames (`useContextUsage` → the `ObservabilityPane`'s usage
  // breakdown) AND `tool.diff` frames (`useToolDiffs` → the pane's `DiffsSection`
  // → mounted `DiffPanel`s) are now CONSUMED here. Default-OFF: when the daemon
  // sends no canvas frames (no `QUANTA_WEB_CANVAS=1`) the source never fires,
  // `contextUsage` stays `null` + `toolDiffs` stays empty, and the pane renders
  // nothing (chat UI byte-identical).
  const canvasSource = useMemo<CanvasSource>(
    () => ({
      subscribe: (handler) => client.onCanvas(handler),
    }),
    [client],
  )
  const contextUsage = useContextUsage(canvasSource)
  const toolDiffs = useToolDiffs(canvasSource)

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
  const agentState = useAgentState(agentStateHub.source)

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
  const hasAgentState = agentState.plan !== null || agentStateHasContent(agentState)
  const hasObservabilityData = computeHasObservabilityData(
    observability,
    contextUsage,
    toolDiffs.size > 0,
    hasAgentState,
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
      />
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
          pendingApprovals={pendingApprovals}
          onApprovalDecision={onApprovalDecision}
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
              </aside>
            ) : null}
            <ObservabilityPane state={observability} usage={contextUsage} diffs={toolDiffs} />
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
