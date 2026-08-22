/**
 * Browser slice — bounded console ring buffer (ADR-0427, console capture).
 *
 * Captures `console.*` calls + uncaught errors + Log.entryAdded into a buffer
 * bounded BOTH by entry COUNT and total TEXT bytes — a page that spams the
 * console (or logs one giant string) must never grow this without bound. When a
 * cap is exceeded the OLDEST entries are dropped and a `dropped` counter tracks
 * how many were lost, so the model can tell its console view is truncated.
 *
 * Pure (no IO / no timers); the adapter pushes parsed entries in and reads them
 * out. Unit-tested directly with synthetic entries — no browser needed.
 */

import type { ConsoleEntry, ConsoleLevel } from "../types"

export interface ConsoleBuffer {
  push(entry: ConsoleEntry): void
  /** Snapshot the current entries + total dropped count. `clear` drains the
   *  buffer and resets the dropped counter. */
  drain(clear: boolean): { readonly entries: readonly ConsoleEntry[]; readonly dropped: number }
}

export interface ConsoleBufferOpts {
  /** Max retained entries (default 200). */
  readonly maxEntries?: number
  /** Max total `text` bytes across retained entries (default 65536). */
  readonly maxBytes?: number
}

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8")

export const createConsoleBuffer = (opts: ConsoleBufferOpts = {}): ConsoleBuffer => {
  const maxEntries = opts.maxEntries ?? 200
  const maxBytes = opts.maxBytes ?? 65_536
  let entries: ConsoleEntry[] = []
  let bytes = 0
  let dropped = 0

  const evictOldest = (): void => {
    const e = entries.shift()
    if (e === undefined) return
    bytes -= byteLen(e.text)
    dropped += 1
  }

  return {
    push(entry: ConsoleEntry): void {
      entries.push(entry)
      bytes += byteLen(entry.text)
      // Evict by either bound. Keep at least the just-pushed entry even if it
      // alone exceeds the byte cap (so a single huge log is still visible once,
      // not silently swallowed) — only drop it if there is something older.
      while (entries.length > maxEntries && entries.length > 0) evictOldest()
      while (bytes > maxBytes && entries.length > 1) evictOldest()
    },
    drain(clear: boolean) {
      const snapshot = entries.slice()
      const out = { entries: snapshot, dropped }
      if (clear) {
        entries = []
        bytes = 0
        dropped = 0
      }
      return out
    },
  }
}

/** Map a `Runtime.consoleAPICalled.type` to a closed {@link ConsoleLevel}. */
export const mapConsoleApiType = (type: unknown): ConsoleLevel => {
  switch (type) {
    case "info":
      return "info"
    case "warning":
      return "warn"
    case "error":
    case "assert":
      return "error"
    case "debug":
      return "debug"
    default:
      // log / trace / dir / table / count / etc → log
      return "log"
  }
}

/** Map a `Log.entryAdded.entry.level` to a closed {@link ConsoleLevel}. */
export const mapLogEntryLevel = (level: unknown): ConsoleLevel => {
  switch (level) {
    case "warning":
      return "warn"
    case "error":
      return "error"
    case "info":
      return "info"
    case "debug":
    case "verbose":
      return "debug"
    default:
      return "log"
  }
}

/** Flatten a `Runtime.consoleAPICalled.args` RemoteObject[] into a single text
 *  string (value-or-description per arg, space-joined). */
export const consoleArgsToText = (args: unknown): string => {
  if (!Array.isArray(args)) return ""
  const parts: string[] = []
  for (const a of args) {
    if (typeof a !== "object" || a === null) continue
    const o = a as { value?: unknown; description?: unknown; type?: unknown }
    if (o.value !== undefined) parts.push(typeof o.value === "string" ? o.value : String(o.value))
    else if (typeof o.description === "string") parts.push(o.description)
    else if (typeof o.type === "string") parts.push(`[${o.type}]`)
  }
  return parts.join(" ")
}
