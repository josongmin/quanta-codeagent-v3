import { errMessage, QuantaError } from "@/shared"
import type { McpResult } from "../resources"

/** Typed MCP failure. Stable code lets callers branch without string matching.
 *
 *  R4 (structured-401) — when a failure originated from an HTTP transport
 *  non-2xx, the carrier surfaces the REAL numeric status through the JSON-RPC
 *  error's `data.httpStatus` slot; `dispatch` copies it onto `httpStatus` here
 *  so auth-staleness can key off a STRUCTURED signal rather than substring-
 *  matching the message text (the conservative legacy fallback is kept for
 *  transports/servers that carry no structured status). `undefined` for every
 *  non-HTTP error (stdio, timeout, local refusal). */
export class McpError extends QuantaError {
  /** R4 — the HTTP status this error carried, when the transport surfaced one
   *  structurally (`error.data.httpStatus`). `undefined` otherwise. */
  readonly httpStatus?: number
  /** Ticket misc-jun-7/01 R2 — the JSON-RPC error `code` this failure carried,
   *  when it originated from a server `error` envelope (copied by
   *  {@link McpClient.resolveResponse}). `undefined` for a non-protocol failure
   *  (timeout, connection refusal, transport synth) — the absence is itself the
   *  signal that the §4.c re-offer must NOT fire (a re-offer is scoped to a
   *  genuine version-REJECTION code, not any McpError). */
  readonly jsonRpcCode?: number
  constructor(
    message: string,
    options?: { cause?: unknown; httpStatus?: number; jsonRpcCode?: number },
  ) {
    super("mcp", message, options)
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus
    if (options?.jsonRpcCode !== undefined) this.jsonRpcCode = options.jsonRpcCode
  }
}

/** Ticket misc-jun-7/01 R2 — the JSON-RPC error codes a strict server uses to
 *  REJECT an unspeakable `initialize` offer (a version-rejection), per JSON-RPC
 *  2.0 §5.1: `InvalidParams (-32602)` (the ticket §4.c canonical) and
 *  `InvalidRequest (-32600)`. A re-offer at the floor is scoped to EXACTLY these
 *  — a timeout / connection refusal (no code) or a transient server fault
 *  (`InternalError -32603`, app-defined `-32000`) is NOT a version rejection and
 *  must propagate WITHOUT a downgrade probe (else a transient hiccup silently
 *  pins the OLDER protocol — a capability loss). */
export const VERSION_REJECTION_CODES: ReadonlySet<number> = new Set([-32602, -32600])

/** H19 — build the typed `unsupported` failure for a method whose required
 *  server capability was not advertised. Refusing locally (instead of emitting
 *  the request and surfacing the server's raw `-32601`) gives the caller a
 *  stable, branchable reason. */
export const unsupported = <T>(capability: string, serverName: string): McpResult<T> => ({
  ok: false,
  reason: "unsupported",
  message: `mcp server "${serverName}" does not advertise the "${capability}" capability`,
})

/** H18 / R2 #1 / R4 — does `err` represent a GENUINE HTTP 401 (Unauthorized)
 *  surfaced through the request core, as opposed to an arbitrary error whose
 *  text merely mentions "401" or "unauthorized"?
 *
 *  R4 (structured-401) — PREFER the STRUCTURED signal: an {@link McpError} that
 *  carries `httpStatus` (copied by `dispatch` from the transport's
 *  `error.data.httpStatus`) is auth-stale IFF that number is exactly `401`.
 *  This is immune to message-text spoofing entirely — a server whose 500-body
 *  text contains "HTTP 401" cannot trigger a re-auth because the structured
 *  status it carries is 500, not 401. A non-401 structured status (403/500/…)
 *  is DEFINITIVELY not auth-stale and short-circuits without consulting text.
 *
 *  FALLBACK (only when NO structured status is present — stdio carriers, or a
 *  transport that did not surface one): the conservative legacy substring match
 *  on the transport's own `HTTP 401` status marker. The ONLY non-structured way
 *  a real auth failure reaches here is the HTTP-SSE carrier's synthesized
 *  `transport POST failed: HTTP 401` message. We key off that token — NOT a bare
 *  `401` (which would spuriously fire on, e.g., `access-401.txt`, a line number,
 *  or a version string) and NOT a bare `unauthorized` (which would fire on any
 *  application-level authorization error a tool/server happens to phrase that
 *  way). Matching is bounded to the literal `HTTP 401` token (case-insensitive
 *  on `HTTP`, word-bounded on `401` so `HTTP 4012` / `HTTP 401x` never match). */
export const isUnauthorizedError = (err: unknown): boolean => {
  // Structured signal wins when present: it is unforgeable by message text.
  if (err instanceof McpError && err.httpStatus !== undefined) {
    return err.httpStatus === 401
  }
  const msg = errMessage(err)
  return /\bHTTP\s+401\b/i.test(msg)
}

/** R4 (structured-401) — extract a numeric `httpStatus` from a JSON-RPC error's
 *  `data` slot when the transport attached one. Only a finite integer in the
 *  HTTP status range is accepted; anything else (absent, non-object, non-number,
 *  NaN, out-of-range) yields `undefined` so the conservative substring fallback
 *  applies. A hostile server cannot smuggle a non-401 into a 401 because we read
 *  the EXACT number, not its string form. */
export const httpStatusOf = (data: unknown): number | undefined => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
  const raw = (data as Record<string, unknown>).httpStatus
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 100 || raw > 599) return undefined
  return raw
}
