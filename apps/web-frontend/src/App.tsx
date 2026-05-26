import { useEffect, useMemo, useRef, useState } from "react"
import { ChatPanel } from "./components/ChatPanel"
import { HotkeyToast } from "./components/HotkeyToast"
import { StatusBar } from "./components/StatusBar"
import { SessionClient } from "./ws/client"
import {
  useConnectionState,
  useSendTurn,
  useSessionEvents,
} from "./ws/session-hooks"

/**
 * Top-level app shell.
 *
 * Owns:
 *   - the SessionClient singleton (one per page load)
 *   - the chat input string (controlled component for InputBar)
 *   - the "hotkey capture" payload that HotkeyToast appends to input
 *
 * Build-time env (Vite):
 *   - VITE_QUANTA_WS_URL      default ws://127.0.0.1:4096/
 *   - VITE_QUANTA_AUTH_TOKEN  optional
 */

const DEFAULT_WS_URL = "ws://127.0.0.1:4096/"

const SESSION_ID_PLACEHOLDER = "ui-session"

const getEnv = (key: "VITE_QUANTA_WS_URL" | "VITE_QUANTA_AUTH_TOKEN"):
  | string
  | undefined => {
  const env = (
    import.meta as unknown as {
      env?: Partial<Record<string, string>>
    }
  ).env
  return env?.[key]
}

export const App = (): JSX.Element => {
  const client = useMemo(() => new SessionClient(), [])
  const connection = useConnectionState(client)
  const { messages, sessionState } = useSessionEvents(client)
  const sendTurn = useSendTurn(client, SESSION_ID_PLACEHOLDER)

  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Wire connect on mount / disconnect on unmount.
  useEffect(() => {
    const wsUrl = getEnv("VITE_QUANTA_WS_URL") ?? DEFAULT_WS_URL
    const token = getEnv("VITE_QUANTA_AUTH_TOKEN")
    client.connect(token === undefined ? { url: wsUrl } : { url: wsUrl, auth: { token } })
    return () => {
      client.disconnect()
    }
  }, [client])

  // Hotkey toast → append to draft + focus
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

  const submit = (text: string): void => {
    sendTurn(text)
    setDraft("")
  }

  return (
    <div className="flex h-full min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-accent">
            quanta
          </span>
          <span className="text-xs text-neutral-500">web</span>
        </div>
        <StatusBar
          connection={connection}
          sessionStatus={sessionState?.status ?? null}
        />
      </header>
      <ChatPanel
        messages={messages}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submit}
        inputRef={inputRef}
        disabled={connection.kind !== "connected"}
      />
      <HotkeyToast />
    </div>
  )
}

interface HotkeyCapturePayload {
  readonly kind: "quanta:hotkey-capture"
  readonly text: string
}

const isHotkeyCapturePayload = (
  value: unknown,
): value is HotkeyCapturePayload => {
  if (value === null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    obj.kind === "quanta:hotkey-capture" &&
    typeof obj.text === "string"
  )
}
