/**
 * UUX-4-06 (plan D-10) — thread-list fetch core (pure, DOM-free).
 *
 * The daemon has served `GET /threads` (fetch-handler.ts — every persisted
 * thread, most-recently-touched first) since the persistence wave, but no
 * frontend consumer existed. This module is that consumer's core: fetch +
 * defensive decode of `{ threads: ThreadInfo[] }` into typed rows for the
 * `ThreadPicker` component. Opening a listed thread then rides the EXISTING
 * resume path (`lib/thread-resume.ts` — read-only history hydration with the
 * honest live-attach boundary); this module only lists addresses.
 *
 * NEVER throws: abort / non-2xx / network error / malformed body map to a
 * typed `{ok:false}` outcome (same discipline as `hydrateThreadResume`).
 * A 404 is the daemon's "persistence disabled" signal — reported as
 * `not_found` so the picker can explain instead of rendering an empty pane.
 * Malformed rows inside an otherwise-valid body are individually dropped.
 */

import type { FetchLike } from "./thread-resume"

/** One row of the daemon's `GET /threads` payload (persistence-sqlite
 *  `ThreadInfo`, mirrored — the web-frontend is a separate build root). */
export interface ThreadListRow {
  readonly id: string
  readonly title: string | null
  readonly createdAt: number
  readonly lastTouched: number
  readonly eventCount: number
}

export type ThreadListFailure =
  | "aborted"
  | "not_found"
  | "http_error"
  | "network_error"
  | "malformed_body"

export type ThreadListOutcome =
  | { readonly ok: true; readonly threads: readonly ThreadListRow[] }
  | { readonly ok: false; readonly reason: ThreadListFailure }

/** Build the list URL. One place so the route contract is pinned by test. */
export const threadsUrl = (httpBase: string): string => `${httpBase.replace(/\/$/, "")}/threads`

/** Defensive per-row decode — a junk row yields `null` and is dropped. */
const decodeRow = (raw: unknown): ThreadListRow | null => {
  if (raw === null || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== "string" || obj.id.length === 0) return null
  return {
    id: obj.id,
    title: typeof obj.title === "string" && obj.title.length > 0 ? obj.title : null,
    createdAt: typeof obj.createdAt === "number" ? obj.createdAt : 0,
    lastTouched: typeof obj.lastTouched === "number" ? obj.lastTouched : 0,
    eventCount: typeof obj.eventCount === "number" ? obj.eventCount : 0,
  }
}

export interface FetchThreadListArgs {
  /** HTTP base (no trailing slash required), e.g. `http://127.0.0.1:4096`. */
  readonly httpBase: string
  /** Bearer token, when the daemon requires auth (same as the resume path). */
  readonly token?: string
  readonly fetchImpl: FetchLike
  readonly signal?: AbortSignal
}

/** Fetch + validate the persisted thread list. Never throws. */
export const fetchThreadList = async (args: FetchThreadListArgs): Promise<ThreadListOutcome> => {
  const { httpBase, token, fetchImpl, signal } = args
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.Authorization = `Bearer ${token}`

  let resp: Awaited<ReturnType<FetchLike>>
  try {
    resp = await fetchImpl(threadsUrl(httpBase), {
      headers,
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") {
      return { ok: false, reason: "aborted" }
    }
    return { ok: false, reason: "network_error" }
  }
  if (!resp.ok) {
    // 404 = persistence disabled at the daemon (`{error:"persistence_disabled"}`).
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
  const rawThreads = (body as { threads?: unknown }).threads
  if (!Array.isArray(rawThreads)) {
    return { ok: false, reason: "malformed_body" }
  }
  const threads: ThreadListRow[] = []
  for (const raw of rawThreads) {
    const row = decodeRow(raw)
    if (row !== null) threads.push(row)
  }
  return { ok: true, threads }
}
