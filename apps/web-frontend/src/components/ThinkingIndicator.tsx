import { useEffect, useState } from "react"
import type { SessionStatus } from "../types/protocol"

export interface ThinkingIndicatorProps {
  /** Current session status — show only while the turn is actively running. */
  readonly sessionStatus: SessionStatus | null
  /**
   * Have we already received an `assistant_text` delta? If yes the message
   * list itself renders the streaming bubble, so the standalone indicator
   * gets out of the way.
   */
  readonly isStreaming: boolean
}

/**
 * CLI parity: while the turn is `running` but no assistant tokens have
 * streamed yet, show an animated three-dot row. Once the first delta lands,
 * the streaming message bubble takes over and this indicator hides itself.
 */
export const ThinkingIndicator = ({
  sessionStatus,
  isStreaming,
}: ThinkingIndicatorProps): JSX.Element | null => {
  const visible = sessionStatus === "running" && !isStreaming
  const elapsedSec = useElapsedSeconds(visible)
  if (!visible) return null
  return (
    <div className="mt-2 flex items-center gap-2 px-1 text-xs text-neutral-500">
      <span className="flex gap-0.5" aria-label="thinking">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500" style={{ animationDelay: "0ms" }} />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500" style={{ animationDelay: "120ms" }} />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500" style={{ animationDelay: "240ms" }} />
      </span>
      <span className="font-mono">
        thinking{elapsedSec >= 2 ? ` · ${elapsedSec}s` : ""}
      </span>
    </div>
  )
}

const useElapsedSeconds = (active: boolean): number => {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) {
      setSeconds(0)
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    const handle = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => {
      clearInterval(handle)
    }
  }, [active])
  return seconds
}
