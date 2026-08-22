/**
 * `@/llm/openai-responses-output-items` — Responses OUTPUT-item normalization.
 *
 * ONE responsibility: fold a raw Responses `output_item` payload into the
 * re-emittable INPUT-item shape the continuation store persists and re-feeds.
 * Split out of `openai-responses-wire.ts` (which owns the request body and the
 * SSE stream) so the two concerns are separately readable and neither module
 * approaches the god-module ceiling. Imports NOTHING from the wire — the
 * dependency runs one way (wire -> here), so there is no module cycle.
 *
 * PURE + no-throw: an unrecognised / malformed item normalizes to `null`
 * (safe-skip), never an exception.
 */

export interface ResponsesInputItem {
  readonly type: string
  readonly [k: string]: unknown
}

/** Structural object guard shared by every normalizer here, and re-used by the
 *  wire's SSE decode. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object"

const normalizeMessageOutputItem = (item: Record<string, unknown>): ResponsesInputItem | null => {
  if (item.role !== "assistant" || !Array.isArray(item.content)) return null
  const content: ResponsesInputItem[] = []
  for (const part of item.content) {
    if (!isObject(part) || part.type !== "output_text" || typeof part.text !== "string") return null
    content.push({ type: "output_text", text: part.text })
  }
  return { type: "message", role: "assistant", content }
}

const normalizeFunctionCallArguments = (value: unknown): string | null => {
  if (typeof value === "string") return value
  if (value === undefined) return "{}"
  try {
    const json = JSON.stringify(value)
    return typeof json === "string" ? json : null
  } catch {
    return null
  }
}

const normalizeFunctionCallOutputItem = (
  item: Record<string, unknown>,
): ResponsesInputItem | null => {
  if (typeof item.call_id !== "string" || typeof item.name !== "string") return null
  const argumentsJson = normalizeFunctionCallArguments(item.arguments)
  if (argumentsJson === null) return null
  return {
    type: "function_call",
    call_id: item.call_id,
    name: item.name,
    arguments: argumentsJson,
  }
}

/**
 * H15 — normalize a Responses `reasoning` OUTPUT item into a re-emittable
 * INPUT reasoning item (the shape Codex re-feeds: `type: "reasoning"` carrying
 * the opaque `encrypted_content`, plus `id`/`summary` when present).
 *
 * Returns `null` (safe-skip) when there is no usable `encrypted_content`:
 *   - missing / non-string / empty `encrypted_content` ⇒ nothing to carry over.
 * A null here means the host captures nothing for this item and the turn stays
 * non-resumable exactly as before — never a crash on a malformed reasoning
 * payload (mirrors Codex's "contained no … encrypted_content" reducer skip).
 *
 * The `summary` is preserved verbatim ONLY when it is an array (the Responses
 * reasoning-summary shape); anything else is dropped. The body is NEVER decoded
 * locally (ZDR — `encrypted_content` is opaque ciphertext).
 */
export const normalizeResponsesReasoningItem = (item: unknown): ResponsesInputItem | null => {
  if (!isObject(item) || item.type !== "reasoning") return null
  const encrypted = item.encrypted_content
  if (typeof encrypted !== "string" || encrypted === "") return null
  return {
    type: "reasoning",
    ...(typeof item.id === "string" && item.id !== "" ? { id: item.id } : {}),
    encrypted_content: encrypted,
    ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
  }
}

export const normalizeResponsesOutputItem = (item: unknown): ResponsesInputItem | null => {
  if (!isObject(item) || typeof item.type !== "string") return null
  switch (item.type) {
    case "message":
      return normalizeMessageOutputItem(item)
    case "function_call":
      return normalizeFunctionCallOutputItem(item)
    default:
      return null
  }
}
