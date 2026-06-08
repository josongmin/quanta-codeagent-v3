/**
 * Header pill showing the daemon's actual WS host:port — the user wanted
 * "show me which port we're on" because the daemon now falls back to an
 * OS-picked port when its preferred port is taken (multi-daemon dev,
 * Quanta.app + standalone, etc.). Parses host/port out of the resolved
 * wsUrl so a single source of truth (the resolved connection) drives the
 * label.
 */

import { cx } from "../lib/classnames"

export interface PortBadgeProps {
  /** Resolved WebSocket URL the SessionClient connected to. */
  readonly wsUrl: string | null
  /** True if the WS is in the `connected` state. Drives the color. */
  readonly connected: boolean
}

const parseHostPort = (raw: string): { host: string; port: string } | null => {
  try {
    const u = new URL(raw)
    const port = u.port !== "" ? u.port : u.protocol === "wss:" ? "443" : "80"
    return { host: u.hostname, port }
  } catch {
    return null
  }
}

export const PortBadge = ({ wsUrl, connected }: PortBadgeProps): JSX.Element | null => {
  if (wsUrl === null || wsUrl.length === 0) return null
  const parsed = parseHostPort(wsUrl)
  if (parsed === null) return null
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-ink-secondary"
      title={wsUrl}
    >
      <span
        aria-hidden="true"
        className={cx(
          "size-1.5 shrink-0 rounded-full",
          connected ? "bg-ok" : "bg-ink-tertiary",
        )}
      />
      <span className="font-mono text-[11px]">
        <span className="text-ink-tertiary">{parsed.host}:</span>
        <span className="ml-0.5 text-ink-secondary">{parsed.port}</span>
      </span>
    </div>
  )
}
