import { useState } from "react"
import { cx } from "../lib/classnames"
import type { ConnectionState, SessionStatus } from "../types/protocol"

export interface StatusBarProps {
  readonly connection: ConnectionState
  readonly sessionStatus: SessionStatus | null
  /**
   * If provided, a "재시작" button is rendered while the connection is
   * `disconnected` or `closed`. Clicking it triggers a daemon restart via
   * the Tauri shell; resolves once the new daemon is up (frontend reconnects
   * automatically via the `quanta:config-ready` event the shell emits).
   */
  readonly onRestartDaemon?: () => Promise<void>
}

const DOT_BY_KIND: Record<ConnectionState["kind"], string> = {
  connected: "bg-ok",
  connecting: "bg-warn animate-pulse",
  disconnected: "bg-err",
  closed: "bg-ink-faint",
}

export const StatusBar = ({
  connection,
  sessionStatus,
  onRestartDaemon,
}: StatusBarProps): JSX.Element => {
  const [restarting, setRestarting] = useState(false)
  const showRestart =
    onRestartDaemon !== undefined &&
    (connection.kind === "disconnected" || connection.kind === "closed")
  const handleRestart = async (): Promise<void> => {
    if (onRestartDaemon === undefined || restarting) return
    setRestarting(true)
    try {
      await onRestartDaemon()
    } finally {
      setRestarting(false)
    }
  }
  return (
    <div className="flex items-center gap-3 text-xs text-ink-secondary">
      <div className="flex items-center gap-1.5">
        <span
          className={cx("inline-block h-2 w-2 rounded-full", DOT_BY_KIND[connection.kind])}
          aria-hidden
        />
        <span className="text-ink-secondary">{renderConnection(connection)}</span>
      </div>
      {sessionStatus !== null ? (
        <div className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
          {sessionStatus}
        </div>
      ) : null}
      {showRestart ? (
        <button
          type="button"
          onClick={() => {
            void handleRestart()
          }}
          disabled={restarting}
          className={cx(
            "rounded-lg border border-line px-3 py-1.5 text-sm text-ink transition hover:bg-white/5",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50",
            "disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent",
          )}
          title="서버(데몬) 재시작"
        >
          {restarting ? "restarting…" : "restart"}
        </button>
      ) : null}
    </div>
  )
}

const renderConnection = (state: ConnectionState): string => {
  switch (state.kind) {
    case "connected":
      return "connected"
    case "connecting":
      return state.attempt > 0
        ? `connecting · attempt ${state.attempt}`
        : "connecting"
    case "disconnected": {
      const seconds = Math.round(state.retryInMs / 1000)
      return `disconnected · retry in ${seconds}s (attempt ${state.attempt})`
    }
    case "closed":
      return "closed"
  }
}
