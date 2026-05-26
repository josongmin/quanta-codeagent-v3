import { cx } from "../lib/classnames"
import type { ConnectionState, SessionStatus } from "../types/protocol"

export interface StatusBarProps {
  readonly connection: ConnectionState
  readonly sessionStatus: SessionStatus | null
}

const DOT_BY_KIND: Record<ConnectionState["kind"], string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-400 animate-pulse",
  disconnected: "bg-red-500",
  closed: "bg-neutral-600",
}

export const StatusBar = ({
  connection,
  sessionStatus,
}: StatusBarProps): JSX.Element => {
  return (
    <div className="flex items-center gap-3 text-xs text-neutral-400">
      <div className="flex items-center gap-1.5">
        <span
          className={cx("inline-block h-2 w-2 rounded-full", DOT_BY_KIND[connection.kind])}
          aria-hidden
        />
        <span className="font-mono">{renderConnection(connection)}</span>
      </div>
      {sessionStatus !== null ? (
        <div className="rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          {sessionStatus}
        </div>
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
