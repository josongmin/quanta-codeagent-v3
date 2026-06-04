/** H19 — pure codecs that narrow raw `resources/*` + `prompts/*` JSON-RPC
 *  results into the typed slice shapes. Each returns `null` on a malformed
 *  response so the client can map it to a typed `malformed` failure (no throw).
 *
 *  Defensive narrowing only — unknown extra fields on the wire are ignored, not
 *  rejected (forward-compat with newer servers). Mirrors the `tools/list` mapper
 *  in `client.ts` but with full no-throw parsing instead of a blind cast. */

import type {
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpPromptResult,
  McpResource,
  McpResourceContent,
} from "./port"

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

/** Build an object carrying only the optional string fields that are present.
 *  Respects `exactOptionalPropertyTypes`: a `?` field is OMITTED, never set to
 *  `undefined`. */
const withOptionalStrings = <K extends string>(
  rec: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, string>> => {
  const out: Partial<Record<K, string>> = {}
  for (const k of keys) {
    const v = str(rec[k])
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Parse a `resources/list` result → `McpResource[]`, or null if `resources`
 *  is not an array. Entries without a string `uri` are dropped. */
export const parseResourceList = (result: unknown): McpResource[] | null => {
  const rec = asRecord(result)
  if (rec === null) return null
  const raw = rec.resources
  if (!Array.isArray(raw)) return null
  const out: McpResource[] = []
  for (const item of raw) {
    const r = asRecord(item)
    if (r === null) continue
    const uri = str(r.uri)
    if (uri === undefined) continue
    out.push({ uri, ...withOptionalStrings(r, ["name", "mimeType", "description"]) })
  }
  return out
}

/** Parse a `resources/read` result → `McpResourceContent[]`, or null if
 *  `contents` is not an array. Entries without a string `uri` are dropped. */
export const parseResourceRead = (result: unknown): McpResourceContent[] | null => {
  const rec = asRecord(result)
  if (rec === null) return null
  const raw = rec.contents
  if (!Array.isArray(raw)) return null
  const out: McpResourceContent[] = []
  for (const item of raw) {
    const c = asRecord(item)
    if (c === null) continue
    const uri = str(c.uri)
    if (uri === undefined) continue
    out.push({ uri, ...withOptionalStrings(c, ["mimeType", "text", "blob"]) })
  }
  return out
}

const parsePromptArgs = (raw: unknown): McpPromptArgument[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const out: McpPromptArgument[] = []
  for (const item of raw) {
    const a = asRecord(item)
    if (a === null) continue
    const name = str(a.name)
    if (name === undefined) continue
    out.push({
      name,
      ...withOptionalStrings(a, ["description"]),
      ...(typeof a.required === "boolean" ? { required: a.required } : {}),
    })
  }
  return out
}

/** Parse a `prompts/list` result → `McpPrompt[]`, or null if `prompts` is not
 *  an array. Entries without a string `name` are dropped. */
export const parsePromptList = (result: unknown): McpPrompt[] | null => {
  const rec = asRecord(result)
  if (rec === null) return null
  const raw = rec.prompts
  if (!Array.isArray(raw)) return null
  const out: McpPrompt[] = []
  for (const item of raw) {
    const p = asRecord(item)
    if (p === null) continue
    const name = str(p.name)
    if (name === undefined) continue
    const args = parsePromptArgs(p.arguments)
    out.push({
      name,
      ...withOptionalStrings(p, ["description"]),
      ...(args !== undefined ? { arguments: args } : {}),
    })
  }
  return out
}

const parsePromptMessage = (v: unknown): McpPromptMessage | null => {
  const rec = asRecord(v)
  if (rec === null) return null
  if (rec.role !== "user" && rec.role !== "assistant") return null
  return { role: rec.role, content: rec.content }
}

/** Parse a `prompts/get` result → `McpPromptResult`, or null if `messages` is
 *  not an array. Malformed individual messages are dropped (an empty message
 *  list is still a valid — if useless — result, so we do not null on that). */
export const parsePromptGet = (result: unknown): McpPromptResult | null => {
  const rec = asRecord(result)
  if (rec === null) return null
  const raw = rec.messages
  if (!Array.isArray(raw)) return null
  const messages: McpPromptMessage[] = []
  for (const m of raw) {
    const parsed = parsePromptMessage(m)
    if (parsed !== null) messages.push(parsed)
  }
  return {
    messages,
    ...withOptionalStrings(rec, ["description"]),
  }
}
