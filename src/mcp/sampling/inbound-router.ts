/** ADR-0470 (jun-04) — inbound `sampling/createMessage` request router.
 *
 *  A connected MCP server can send US a JSON-RPC REQUEST (it has an `id`, a
 *  `method`, and `params`, and expects a reply) asking the client to run an
 *  LLM completion: `sampling/createMessage` (rmcp 0.15). This router turns
 *  that inbound request into a {@link SamplingHandlerPort} call and shapes the
 *  JSON-RPC RESULT the server waits for.
 *
 *  Mirrors `@/mcp/elicitation/inbound-router`: a narrow `is*Method` guard, a
 *  total `route*` that never throws, and a closed response codec. A
 *  malformed/declined request resolves to a JSON-RPC *error* (the spec models a
 *  client refusal as an error, not a `result` envelope) rather than dropping
 *  the request.
 */

import type { CreateMessageRequest, SamplingHandlerPort, SamplingMessage } from "./port"

/** MCP spec method that asks the client to run a model completion. */
export const MCP_SAMPLING_METHOD = "sampling/createMessage"

/** Returns true iff `method` is the sampling request this router handles. */
export const isSamplingMethod = (method: string): boolean => method === MCP_SAMPLING_METHOD

/** JSON-RPC error code for a client that refuses to run sampling. We reuse the
 *  generic `-32000` server-error band (implementation-defined) rather than
 *  `-32601 method not found`, because the method IS recognized — the client
 *  simply declined. The message names the reason for server-side diagnostics. */
export const SAMPLING_DECLINED_CODE = -32000

/** DoS bound — maximum CONCURRENT inbound sampling requests that may be
 *  in-flight (handed to the handler / inference) at once. A hostile server can
 *  fire a flood of `sampling/createMessage` requests to fan out unbounded
 *  concurrent inference (token-spend / resource DoS). Past this cap a request is
 *  DECLINED with a typed `busy` error WITHOUT spawning a task — the server is
 *  answered (never dropped) and back-pressured. 8 allows legitimate modest
 *  concurrency while bounding the worst-case fan-out. */
export const SAMPLING_MAX_IN_FLIGHT = 8

/** Module-level count of inbound sampling requests currently handed to a
 *  handler. Incremented on accept, decremented when the handler settles. A
 *  single-threaded JS event loop makes this a safe non-atomic counter. */
let samplingInFlight = 0

/** DoS bound — maximum `messages` an inbound sampling request may carry. A
 *  hostile/buggy server can flood millions of entries; we refuse an over-cap
 *  array BEFORE copying any of it (no retain, no OOM). 512 is far above any
 *  legitimate sampling conversation while bounding the worst case. */
export const SAMPLING_MAX_MESSAGES = 512

/** DoS bound — maximum characters in a single message's textual content. A
 *  hostile server can send one gigantic payload; we refuse it without retaining
 *  the string. 256 KiB is generous for a prompt (cf. the 200 KiB MCP result
 *  cap) while bounding the per-message memory. Non-text (structured) content is
 *  bounded by the handler/codec that owns its shape. */
export const SAMPLING_MAX_CONTENT_CHARS = 256 * 1024

/** DoS / sanity bound — maximum `maxTokens` an inbound sampling request may
 *  forward into inference. A hostile server can send a `maxTokens` of `1e12`
 *  (or NaN/Infinity/negative) to drive a runaway / nonsensical completion. We
 *  forward `maxTokens` ONLY when it is a finite positive integer at or below
 *  this cap; anything else is DROPPED (the field is omitted, the request still
 *  runs with the handler's own default). 1e6 is far above any legitimate
 *  completion length while bounding the worst-case requested budget. */
export const SAMPLING_MAX_TOKENS = 1_000_000

/** Narrow a hostile/garbage `maxTokens` to a forwardable value, or `undefined`
 *  to DROP the field. Rejects NaN/Infinity/non-integer/<=0 and clamps an
 *  over-cap request to {@link SAMPLING_MAX_TOKENS} (never forwards the raw
 *  hostile value). */
const sanitizeMaxTokens = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return undefined
  return v > SAMPLING_MAX_TOKENS ? SAMPLING_MAX_TOKENS : v
}

/** Cheap upper bound on a message content's textual size WITHOUT materializing
 *  a serialization (no retain). Covers a raw string and the `{ text }` text
 *  block; structured/binary blocks are handler-owned and return 0 here. */
const contentChars = (content: unknown): number => {
  if (typeof content === "string") return content.length
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    const t = (content as Record<string, unknown>).text
    if (typeof t === "string") return t.length
  }
  return 0
}

/** The closed JSON-RPC response we hand back: either a `result` (a fulfilled
 *  completion) or an `error` (a typed decline). */
export type SamplingResponse =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "error"; readonly code: number; readonly message: string }

/** Narrow `params` to a plain record (or null). */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Narrow one wire message to a {@link SamplingMessage}, or null if it lacks a
 *  valid `role`. `content` is passed through verbatim (the handler owns the
 *  block codec). */
const toMessage = (v: unknown): SamplingMessage | null => {
  const rec = asRecord(v)
  if (rec === null) return null
  if (rec.role !== "user" && rec.role !== "assistant") return null
  return { role: rec.role, content: rec.content }
}

/** Parse inbound `params` into a typed {@link CreateMessageRequest}. Returns
 *  null when `messages` is absent/empty or no entry is well-formed — the
 *  caller then declines (well-defined, not dropped). */
const parseRequest = (params: Record<string, unknown>): CreateMessageRequest | null => {
  const rawMessages = params.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null
  // DoS bound: refuse an over-cap message array BEFORE copying ANY of it — the
  // hostile flood is never retained (no OOM).
  if (rawMessages.length > SAMPLING_MAX_MESSAGES) return null
  const messages: SamplingMessage[] = []
  for (const m of rawMessages) {
    const parsed = toMessage(m)
    if (parsed === null) continue
    // DoS bound: refuse a single gigantic content payload (the string is not
    // copied into the request — we measure and drop the whole request).
    if (contentChars(parsed.content) > SAMPLING_MAX_CONTENT_CHARS) return null
    messages.push(parsed)
  }
  if (messages.length === 0) return null
  return {
    messages,
    ...(typeof params.systemPrompt === "string" ? { systemPrompt: params.systemPrompt } : {}),
    ...((): { maxTokens?: number } => {
      // DoS / sanity bound: drop a hostile/garbage maxTokens (NaN/Infinity/
      // negative/non-int) and clamp an over-cap value — never forward the raw
      // hostile number into inference.
      const mt = sanitizeMaxTokens(params.maxTokens)
      return mt === undefined ? {} : { maxTokens: mt }
    })(),
    ...(params.modelPreferences !== undefined ? { modelPreferences: params.modelPreferences } : {}),
    ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
  }
}

const declined = (message: string): SamplingResponse => ({
  kind: "error",
  code: SAMPLING_DECLINED_CODE,
  message,
})

/** Route an inbound `sampling/createMessage` request onto `handler`, returning
 *  the JSON-RPC response (result or typed-decline error) to send back. Never
 *  throws: a handler that rejects (the contract says it should not) is mapped
 *  to a decline rather than left dropping the request. */
export const routeSampling = async (
  handler: SamplingHandlerPort,
  method: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<SamplingResponse> => {
  if (method !== MCP_SAMPLING_METHOD) {
    // Caller guards with isSamplingMethod; defensive decline.
    return declined("sampling: unsupported method")
  }
  const req = parseRequest(asRecord(params) ?? {})
  if (req === null) return declined("sampling: malformed createMessage params")

  // DoS bound: refuse to fan out beyond the in-flight cap. We back-pressure the
  // server with a typed decline (the word "in-flight" is load-bearing for the
  // server's diagnostics) WITHOUT spawning a task — the hostile flood never
  // reaches the handler / inference.
  if (samplingInFlight >= SAMPLING_MAX_IN_FLIGHT) {
    return declined(`sampling: too many in-flight requests (cap ${SAMPLING_MAX_IN_FLIGHT})`)
  }

  samplingInFlight++
  let outcome: Awaited<ReturnType<SamplingHandlerPort["createMessage"]>>
  try {
    outcome = await handler.createMessage(req, signal)
  } catch {
    // Defensive: the port contract is no-throw, but a custom impl that rejects
    // must still get a well-defined answer.
    return declined("sampling: handler error")
  } finally {
    samplingInFlight--
  }
  if (outcome.ok) return { kind: "result", result: outcome.result }
  return declined(`sampling declined: ${outcome.reason}`)
}
