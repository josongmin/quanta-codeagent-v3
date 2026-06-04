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
  const messages: SamplingMessage[] = []
  for (const m of rawMessages) {
    const parsed = toMessage(m)
    if (parsed !== null) messages.push(parsed)
  }
  if (messages.length === 0) return null
  return {
    messages,
    ...(typeof params.systemPrompt === "string" ? { systemPrompt: params.systemPrompt } : {}),
    ...(typeof params.maxTokens === "number" ? { maxTokens: params.maxTokens } : {}),
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

  let outcome: Awaited<ReturnType<SamplingHandlerPort["createMessage"]>>
  try {
    outcome = await handler.createMessage(req, signal)
  } catch {
    // Defensive: the port contract is no-throw, but a custom impl that rejects
    // must still get a well-defined answer.
    return declined("sampling: handler error")
  }
  if (outcome.ok) return { kind: "result", result: outcome.result }
  return declined(`sampling declined: ${outcome.reason}`)
}
