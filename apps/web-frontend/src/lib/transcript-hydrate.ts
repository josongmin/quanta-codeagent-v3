/**
 * WS-F (UUX-5-07) — transcript hydration with a TYPED outcome.
 *
 * Fetches the persisted session events (`GET /threads/:id/events`) and
 * replays them through the caller's fanout. Every failure path returns
 * `{ ok: false, reason }` so the App can raise the degraded banner — the
 * pre-fix inline effect did `if (!resp.ok) return`, which rendered a
 * silently empty transcript on any daemon hiccup.
 *
 * Shape mirrors `thread-resume.ts` (`hydrateThreadResume`): pure async
 * helper, injected `fetchImpl`, never throws for expected failures.
 */

import type { SessionEvent } from "../types/protocol"

export type TranscriptHydrateOutcome =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: string; readonly aborted?: boolean }

const isAbortError = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === "AbortError"

export const hydrateTranscript = async (args: {
  readonly httpBase: string
  readonly sessionId: string
  readonly token?: string
  readonly fetchImpl: typeof fetch
  readonly signal?: AbortSignal
  /** Replay sink — the caller routes events through the SAME dispatch path
   *  as live WS frames (the reducer's eventId dedup absorbs overlap). */
  readonly replay: (events: readonly SessionEvent[]) => void
}): Promise<TranscriptHydrateOutcome> => {
  const base = args.httpBase.replace(/\/+$/, "")
  const url = `${base}/threads/${encodeURIComponent(args.sessionId)}/events`
  const headers: Record<string, string> = {}
  if (args.token !== undefined) {
    headers.Authorization = `Bearer ${args.token}`
  }
  try {
    const resp = await args.fetchImpl(url, {
      headers,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    })
    if (!resp.ok) {
      return { ok: false, reason: `HTTP ${resp.status}` }
    }
    const body = (await resp.json().catch(() => null)) as {
      events?: readonly SessionEvent[]
    } | null
    if (body === null) {
      return { ok: false, reason: "invalid response body" }
    }
    const events = Array.isArray(body.events) ? body.events : []
    if (events.length > 0) {
      args.replay(events)
    }
    return { ok: true, count: events.length }
  } catch (error) {
    if (isAbortError(error)) {
      return { ok: false, reason: "aborted", aborted: true }
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
