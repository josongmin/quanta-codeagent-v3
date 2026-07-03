/**
 * B2 — cross-surface thread handoff RESUME (web-frontend core).
 *
 * The consumer half of the deeplink handoff. A `?thread=<id>` / `#thread=<id>`
 * (or a Tauri-forwarded `quanta://threads/{id}`) names a thread the user wants
 * to OPEN in the web surface. This module is the pure, DOM-free core that turns
 * that requested id into a hydrated transcript by fetching the daemon's
 * thread-addressed persisted event log (`GET /threads/:id/events`).
 *
 * HONEST BOUNDARY (documented, not faked):
 *   The web daemon runs ONE shared `RuntimeSession`; its thread id is
 *   SERVER-MINTED at boot and the LIVE session cannot be switched to a different
 *   thread (every WS client joins the SAME live transcript — see
 *   `@/apps/web-daemon/session-registry`). Therefore a web resume of an
 *   externally-addressed thread is a READ-ONLY HISTORY hydration: we replay that
 *   thread's PERSISTED events into the transcript so the user sees the
 *   conversation, but NEW turns still advance the daemon's live shared session
 *   (which may be a different thread). When the requested id happens to equal the
 *   live session id, the resume is effectively "live-attach" (history + live are
 *   the same thread). The returned {@link ThreadResumeResult.boundary} reports
 *   which case applied so the UI can be honest with the user.
 *
 * SOTA form: mirrors Codex's `codex://threads/{id}` webview handoff
 * (`threadsHandoffToHost` active→completed/failed transitions, `Znn(id)` →
 * `open("codex://threads/${id}")`). Our `quanta://threads/{id}` scheme + this
 * read-only hydration is the same "open/focus a thread by id" leg.
 */

import type { SessionEvent } from "../types/protocol"
import { decodeEventFromEnvelope } from "../ws/envelope"

/** How a resume settled against the daemon's single-shared-session model. */
export type ThreadResumeBoundary =
  /** The requested thread == the daemon's live shared session id: history AND
   *  new turns are the same thread (effective live-attach). */
  | "live-attach"
  /** The requested thread != the live session: we hydrated its PERSISTED
   *  transcript read-only; new turns advance the (different) live session. */
  | "read-only-history"

export interface ThreadResumeResult {
  readonly threadId: string
  /** Persisted events for the requested thread, oldest-first (may be empty for
   *  an unknown / malformed id — that is a clean "nothing to show", not an
   *  error). */
  readonly events: readonly SessionEvent[]
  readonly boundary: ThreadResumeBoundary
}

export type ThreadResumeOutcome =
  | { readonly ok: true; readonly result: ThreadResumeResult }
  /** The fetch failed (network / non-2xx / abort / malformed body). The caller
   *  keeps the current transcript and surfaces a soft "could not resume" note —
   *  NEVER crashes or hangs. `reason` is a coarse tag (no server internals). */
  | { readonly ok: false; readonly reason: ThreadResumeFailure }

export type ThreadResumeFailure =
  | "aborted"
  | "not_found"
  | "http_error"
  | "network_error"
  | "malformed_body"

/** Minimal `fetch` shape the resume depends on — the global browser `fetch`
 *  satisfies it, and tests pass a deterministic stub. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}>

export interface HydrateThreadResumeArgs {
  /** The thread id the user asked to open (deeplink / banner). */
  readonly requestedThreadId: string
  /** The daemon's live shared-session id (server-minted), or null if the
   *  handshake has not settled yet — used ONLY to compute the boundary tag. */
  readonly liveSessionId: string | null
  /** HTTP base (no trailing slash), e.g. `http://127.0.0.1:4000`. */
  readonly httpBase: string
  /** Bearer token, when the daemon requires auth. */
  readonly token?: string
  readonly fetchImpl: FetchLike
  readonly signal?: AbortSignal
}

/**
 * Build the thread-addressed persisted-events URL. Exposed for the caller so the
 * URL contract is asserted in one place. `requestedThreadId` is
 * `encodeURIComponent`-escaped so a malformed / hostile id can never break out
 * of the `/threads/:id/events` path (the daemon then decodes + treats an unknown
 * id as an empty log).
 */
export const threadEventsUrl = (httpBase: string, requestedThreadId: string): string =>
  `${httpBase.replace(/\/$/, "")}/threads/${encodeURIComponent(requestedThreadId)}/events`

/**
 * Fetch + validate the requested thread's persisted transcript. NEVER throws:
 * every failure path (abort, non-2xx, network error, malformed body) is mapped
 * to a typed `{ok:false}` outcome so the caller can render a soft note without a
 * crash or an unresolved hang. Malformed events inside an otherwise-valid body
 * are individually dropped (best-effort), matching the client's live-frame
 * decode discipline.
 */
export const hydrateThreadResume = async (
  args: HydrateThreadResumeArgs,
): Promise<ThreadResumeOutcome> => {
  const { requestedThreadId, liveSessionId, httpBase, token, fetchImpl, signal } = args
  const url = threadEventsUrl(httpBase, requestedThreadId)
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.Authorization = `Bearer ${token}`

  let resp: Awaited<ReturnType<FetchLike>>
  try {
    resp = await fetchImpl(url, { headers, ...(signal !== undefined ? { signal } : {}) })
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") {
      return { ok: false, reason: "aborted" }
    }
    return { ok: false, reason: "network_error" }
  }
  if (!resp.ok) {
    // 404 = persistence disabled OR (in principle) unknown route; the daemon
    // returns an EMPTY log for an unknown thread id at 200, so a 404 here is a
    // genuine "no persistence" boundary, not "unknown thread".
    return { ok: false, reason: resp.status === 404 ? "not_found" : "http_error" }
  }
  let body: unknown
  try {
    body = await resp.json()
  } catch {
    return { ok: false, reason: "malformed_body" }
  }
  if (body === null || typeof body !== "object") {
    return { ok: false, reason: "malformed_body" }
  }
  const rawEvents = (body as { events?: unknown }).events
  if (rawEvents !== undefined && !Array.isArray(rawEvents)) {
    return { ok: false, reason: "malformed_body" }
  }
  // Prefer the daemon's AUTHORITATIVE boundary report (it knows the live session
  // id first-hand). Fall back to the id-derived boundary when the field is
  // absent (older daemon) or not one of the two known tags.
  const reported = (body as { boundary?: unknown }).boundary
  const daemonBoundary: ThreadResumeBoundary | null =
    reported === "live-attach" || reported === "read-only-history" ? reported : null
  const events: SessionEvent[] = []
  if (Array.isArray(rawEvents)) {
    for (const raw of rawEvents) {
      // Reuse the SAME defensive decoder the live receive path uses: a persisted
      // row that does not validate is dropped, never rendered as garbage.
      const decoded =
        raw !== null && typeof raw === "object"
          ? decodeEventFromEnvelope({ kind: "event", payload: raw } as Record<string, unknown>)
          : null
      if (decoded !== null) events.push(decoded)
    }
  }
  return {
    ok: true,
    result: {
      threadId: requestedThreadId,
      events,
      boundary: daemonBoundary ?? resolveResumeBoundary(requestedThreadId, liveSessionId),
    },
  }
}

/**
 * Report the honest boundary: `live-attach` when the requested thread IS the
 * daemon's live shared session (history and new turns coincide), otherwise
 * `read-only-history` (we replayed persisted events but new turns advance the
 * DIFFERENT live session). Computed purely from the two ids so it is trivially
 * testable and carries no hidden state.
 */
export const resolveResumeBoundary = (
  requestedThreadId: string,
  liveSessionId: string | null,
): ThreadResumeBoundary =>
  liveSessionId !== null && liveSessionId === requestedThreadId
    ? "live-attach"
    : "read-only-history"
