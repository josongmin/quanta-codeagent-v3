import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatPanel } from "./components/ChatPanel"
import { ConnectionUrlPill } from "./components/ConnectionUrlPill"
import { HeaderTitle } from "./components/HeaderTitle"
import { HotkeyToast } from "./components/HotkeyToast"
import { KnobsPanel } from "./components/KnobsPanel"
import { ModeBadge } from "./components/ModeBadge"
import { ObservabilityPane } from "./components/ObservabilityPane"
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
import { buildLlmConfigSlashCommands, httpUrlFromWsUrl } from "./components/slash-llm-config"
import type { KnobsEndpoint } from "./components/slash-knobs"
import { TokenCounter } from "./components/TokenCounter"
import { isHotkeyImagePayload, type PendingImageAttachment } from "./composer/image-attachment"
import { useImageAttachment } from "./composer/use-image-attachment"
import type { ConnectionState, SessionEvent, SessionStateView } from "./types/protocol"
import { type CanvasSource, useContextUsage } from "./ws/canvas-hooks"
import { SessionClient } from "./ws/client"
import { type ObservabilitySource, useObservabilityState } from "./ws/observability-hooks"
import {
  type CumulativeTokenUsage,
  useConnectionState,
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
    return [...base, ...llmCommands, ...authCommands]
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

  // ADR-0448 (RFC-10): mount point for the rich context-usage breakdown. The
  // RFC-06 canvas data port (the client-side `tool.diff`/`context.usage`
  // dispatch) is not yet wired onto `SessionClient` — so the source is `null`
  // and `useContextUsage` stays `null`, leaving the panel un-rendered
  // (default-OFF). The moment RFC-06 exposes canvas frames (e.g.
  // `client.onCanvas`), swap `null` for that source and the
  // `UsageBreakdownPanel` lights up with no further change here.
  const canvasSource: CanvasSource | null = null
  const contextUsage = useContextUsage(canvasSource)

  return (
    <div className="flex h-full min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <SessionChrome
        connection={connection}
        model={resolvedModel}
        resolvedConnection={resolvedConnection}
        sessionState={sessionState ?? null}
        tokenUsage={tokenUsage}
        canRestartDaemon={canRestartDaemon}
      />
      <div className="flex min-h-0 flex-1 flex-row">
        <ChatPanel
          messages={messages}
          streamingMessageId={streamingMessageId}
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
        />
        <ObservabilityPane state={observability} usage={contextUsage} />
      </div>
      <HotkeyToast />
      {knobsPanelOpen ? (
        <KnobsPanel endpoint={knobsEndpoint} onClose={closeKnobsPanel} />
      ) : null}
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
  }: SessionChromeProps): JSX.Element => {
    return (
      <>
        {resolvedConnection !== null ? (
          <div className="flex items-center justify-end border-b border-neutral-900 bg-neutral-950 px-4 py-1">
            <ConnectionUrlPill
              url={resolvedConnection.url}
              {...(resolvedConnection.token !== undefined
                ? { token: resolvedConnection.token }
                : {})}
            />
          </div>
        ) : null}
        <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
          <HeaderTitle model={model} />
          <div className="flex items-center gap-3">
            <PortBadge
              wsUrl={resolvedConnection?.url ?? null}
              connected={connection.kind === "connected"}
            />
            <TokenCounter usage={tokenUsage} />
            <ModeBadge state={sessionState} />
            <StatusBar
              connection={connection}
              sessionStatus={sessionState?.status ?? null}
              {...(canRestartDaemon ? { onRestartDaemon: restartDaemonViaTauri } : {})}
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
