/** §19.4 — inbound `notifications/progress` (server → client, no reply).
 *
 *  A server emits progress for a long-running `tools/call` ONLY when the caller
 *  attached a `progressToken` in the request's `_meta`. Each notification carries
 *  `{ progressToken, progress, total?, message? }` (spec 2025-06-18). The token
 *  correlates the notification back to the originating call, so progress is
 *  routed to a PER-CALL handler (unlike resource notifications, which fan out to
 *  one observer). Absent token registration ⇒ the notification is dropped
 *  gracefully (byte-identical to a client that never sent a progressToken).
 */

import { sliceWholeChars } from "@/shared"

export const PROGRESS_METHOD = "notifications/progress"

/** A parsed progress notification. `progressToken` correlates to the call that
 *  supplied it; `progress`/`total` are monotone-ish counters the server defines. */
export interface McpProgress {
  readonly progressToken: string | number
  readonly progress: number
  readonly total?: number
  readonly message?: string
}

/** DoS bound — a hostile/buggy server can attach a multi-megabyte `message` to
 *  every progress tick; we keep only a bounded prefix so the notification is
 *  never a large retain. Sits well above any realistic human-readable status. */
export const PROGRESS_MAX_MESSAGE_CHARS = 2048

export const isProgressMethod = (method: string): boolean => method === PROGRESS_METHOD

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Parse `notifications/progress` params into a typed event, or `null` when the
 *  token is missing/ill-typed or `progress` is not a finite number. `total` is
 *  kept only when a finite number; `message` is kept (length-capped) only when a
 *  string. Nothing here throws — a malformed notification is simply dropped. */
export const parseProgress = (params: unknown): McpProgress | null => {
  const r = asRecord(params)
  if (r === null) return null
  const token = r.progressToken
  if (typeof token !== "string" && typeof token !== "number") return null
  const progress = r.progress
  if (typeof progress !== "number" || !Number.isFinite(progress)) return null
  const out: {
    progressToken: string | number
    progress: number
    total?: number
    message?: string
  } = { progressToken: token, progress }
  if (typeof r.total === "number" && Number.isFinite(r.total)) out.total = r.total
  if (typeof r.message === "string" && r.message !== "") {
    // Surrogate-safe cap: an MCP server message is untrusted UTF-16 and may end
    // its prefix mid-surrogate-pair (emoji); `sliceWholeChars` never splits a
    // pair, so the bounded message can't carry a lone surrogate downstream.
    out.message =
      r.message.length > PROGRESS_MAX_MESSAGE_CHARS
        ? sliceWholeChars(r.message, PROGRESS_MAX_MESSAGE_CHARS)
        : r.message
  }
  return out
}

/** Per-call progress sink. Total + no-throw is the contract; the router never
 *  awaits it (the message pump must not block on a slow consumer). */
export type McpProgressHandler = (event: McpProgress) => void
