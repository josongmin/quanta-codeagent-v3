/**
 * WS-H / UUX-3-01 — background-turn output capture tee.
 *
 * The MISSING half of the Ticket-18 portal: the portal has always exposed
 * `entry.appendOutput` (a bounded HEAD+TAIL buffer) but nothing in production
 * ever fed it, so `/background reattach` replayed an empty buffer. This module
 * is the stream-side seam: session-setup interposes ONE mutable-proxy tee in
 * the surface stream chain (same pattern as `factories/debug-tracer.ts`), and
 * the session loop `install`s a sink at Ctrl+B detach time / removes it when
 * the backgrounded body settles (see `wireBackgroundOutputCapture` in
 * `session-loop/turn-helpers.ts`).
 *
 * Posture:
 *  - Gate OFF (`QUANTA_BG_TURN` unset) ⇒ the literal input stream is returned
 *    and NO capture handle exists — zero allocation in the emit path,
 *    byte-identical default-OFF.
 *  - Gate ON + no sink installed ⇒ the proxy is a `Set.size === 0` check per
 *    event (the tee itself never mutates/filters downstream events).
 *  - A throwing sink is swallowed per-sink (mirrors `TeeStream`'s "one faulty
 *    port never starves the others" posture) — observation never breaks the
 *    live turn.
 *
 * KNOWN V1 LIMIT (documented, not hidden): the surface owns ONE stream for the
 * whole session, so while a foreground turn runs CONCURRENTLY with a detached
 * one, both write into the same event stream and an installed sink captures
 * the interleaving. Per-turn stream separation is a V3 (live reattach) concern.
 */

import type { AgentEvent, StreamPort } from "@/stream"
import { TeeStream } from "@/stream"

/** Sink lifecycle handle: `install` returns the matching remover (idempotent). */
export interface BackgroundStreamCapture {
  install(sink: (chunk: string) => void): () => void
}

/** Project ONE stream event to the text chunk a background buffer should
 *  retain, or `undefined` when the event carries no replayable output.
 *  Captured: the assistant's streamed answer text (verbatim, ordered) plus a
 *  one-line tool-boundary marker (so a reattach shows WHAT the turn was doing
 *  between text runs) and error lines. Lifecycle/usage/plan noise is skipped —
 *  the replay is output, not telemetry. */
export const projectBackgroundChunk = (event: AgentEvent): string | undefined => {
  switch (event.type) {
    case "assistant_text":
      return event.delta
    case "tool_call":
      return `\n[tool] ${event.name}\n`
    case "error":
      return `\n[error] ${event.message}\n`
    default:
      return undefined
  }
}

/** Build the capture tee. `enabled === false` ⇒ `{ stream, capture: undefined }`
 *  with the LITERAL input reference (no wrapper allocated — byte-identical).
 *  Enabled ⇒ a `TeeStream([downstream, proxy])` whose proxy fans projected
 *  chunks out to every installed sink. Multiple sinks may be live at once
 *  (double-detach); each `install` returns its own remover. */
export const buildBackgroundCaptureTee = (
  enabled: boolean,
  stream: StreamPort,
): { stream: StreamPort; capture: BackgroundStreamCapture | undefined } => {
  if (!enabled) return { stream, capture: undefined }
  const sinks = new Set<(chunk: string) => void>()
  const proxy: StreamPort = {
    emit: (event): void => {
      if (sinks.size === 0) return
      const chunk = projectBackgroundChunk(event)
      if (chunk === undefined || chunk.length === 0) return
      for (const sink of sinks) {
        try {
          sink(chunk)
        } catch {
          // Same posture as TeeStream: a faulty observer never poisons the tee.
        }
      }
    },
  }
  const capture: BackgroundStreamCapture = {
    install: (sink) => {
      sinks.add(sink)
      // `Set.delete` is idempotent; each install hands out ITS remover. (Two
      // installs of the SAME function share one Set slot — callers pass fresh
      // per-entry closures, which the detach seam always does.)
      return () => {
        sinks.delete(sink)
      }
    },
  }
  return { stream: new TeeStream([stream, proxy]), capture }
}
