/** H19 — pure codecs that narrow raw `resources/*` + `prompts/*` JSON-RPC
 *  results into the typed slice shapes. Each returns `null` on a malformed
 *  response so the client can map it to a typed `malformed` failure (no throw).
 *
 *  Defensive narrowing only — unknown extra fields on the wire are ignored, not
 *  rejected (forward-compat with newer servers). Mirrors the `tools/list` mapper
 *  in `client.ts` but with full no-throw parsing instead of a blind cast. */

import type {
  McpCompletionResult,
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpPromptResult,
  McpResource,
  McpResourceContent,
  McpResourceTemplate,
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
/** DoS bound — maximum entries retained from a `resources/list` / `prompts/list`
 *  result. A hostile/buggy server can return millions of entries; the parsers
 *  stop pushing at this cap so the flood is never fully retained (no OOM). 4096
 *  is far above any realistic catalog while bounding the worst case. */
export const PARSE_MAX_LIST_ENTRIES = 4096

export const parseResourceList = (result: unknown): McpResource[] | null => {
  const rec = asRecord(result)
  if (rec === null) return null
  const raw = rec.resources
  if (!Array.isArray(raw)) return null
  const out: McpResource[] = []
  for (const item of raw) {
    if (out.length >= PARSE_MAX_LIST_ENTRIES) break // DoS bound — stop retaining
    const r = asRecord(item)
    if (r === null) continue
    const uri = str(r.uri)
    if (uri === undefined) continue
    out.push({ uri, ...withOptionalStrings(r, ["name", "mimeType", "description"]) })
  }
  return out
}

/** B4 — PURE direct-children filter over a `resources/list` result. MCP has no
 *  native `resources/read-dir` RPC; a directory is modeled as a list prefix
 *  (Claude tags subdirs with mimeType `inode/directory`). A "direct child" is an
 *  entry strictly under `dirUri` with NO further `/`-separated segment. The dir
 *  entry itself and grandchildren are excluded; a trailing slash on either side
 *  is normalized. DUPLICATED as `filterDirectChildren` in `@/tool/mcp_resources`
 *  (slice isolation forbids `@/mcp`→`@/tool`); the aggregation hellgate pins that
 *  the two stay behaviorally identical. */
export const directResourceChildren = (
  entries: ReadonlyArray<McpResource>,
  dirUri: string,
): McpResource[] => {
  const base = dirUri.endsWith("/") ? dirUri : `${dirUri}/`
  return entries.filter((e) => {
    if (e.uri === dirUri || e.uri === base) return false
    if (!e.uri.startsWith(base)) return false
    const rest = e.uri.slice(base.length).replace(/\/+$/, "")
    return rest.length > 0 && !rest.includes("/")
  })
}

/** TICKET-20 — Parse a `resources/templates/list` result →
 *  `McpResourceTemplate[]`, or null if `resourceTemplates` is not an array.
 *  Entries WITHOUT a string `uriTemplate` (the spec's required field, RFC 6570)
 *  are dropped — an all-malformed list therefore yields `[]` (a valid, if
 *  empty, result), NOT a `malformed` failure. Reuses {@link withOptionalStrings}
 *  for the descriptor fields and the same `PARSE_MAX_LIST_ENTRIES` DoS bound as
 *  the other list parsers. */
export const parseResourceTemplateList = (result: unknown): McpResourceTemplate[] | null => {
  const rec = asRecord(result)
  if (rec === null) return null
  const raw = rec.resourceTemplates
  if (!Array.isArray(raw)) return null
  const out: McpResourceTemplate[] = []
  for (const item of raw) {
    if (out.length >= PARSE_MAX_LIST_ENTRIES) break // DoS bound — stop retaining
    const r = asRecord(item)
    if (r === null) continue
    const uriTemplate = str(r.uriTemplate)
    if (uriTemplate === undefined) continue
    out.push({ uriTemplate, ...withOptionalStrings(r, ["name", "description", "mimeType"]) })
  }
  return out
}

/** TICKET-20 — Parse a `completion/complete` result → {@link McpCompletionResult}.
 *  Navigates `result.completion.{values[], total?, hasMore?}`:
 *   - `result.completion` not an object → null (typed `malformed` upstream);
 *   - `values` defaults to `[]` and is filtered to STRINGS only (defensive
 *     narrowing), capped at `PARSE_MAX_LIST_ENTRIES`. An EMPTY `values:[]` is a
 *     VALID, non-null result (the server simply has no suggestion);
 *   - `total`/`hasMore` are carried through only when the right primitive type. */
export const parseCompletionResult = (result: unknown): McpCompletionResult | null => {
  const rec = asRecord(result)
  if (rec === null) return null
  const completion = asRecord(rec.completion)
  if (completion === null) return null // completion-not-object ⇒ malformed
  const rawValues = completion.values
  const values: string[] = []
  if (Array.isArray(rawValues)) {
    for (const v of rawValues) {
      if (values.length >= PARSE_MAX_LIST_ENTRIES) break // DoS bound
      const s = str(v)
      if (s !== undefined) values.push(s)
    }
  }
  return {
    values,
    ...(typeof completion.total === "number" ? { total: completion.total } : {}),
    ...(typeof completion.hasMore === "boolean" ? { hasMore: completion.hasMore } : {}),
  }
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

/** R2 #3 — defensive cap on the CUMULATIVE size (in UTF-16 code units, the JS
 *  `string.length`) of the `text` + `blob` content a single `resources/read`
 *  may return. A malicious/buggy server could otherwise stream an arbitrarily
 *  large `blob`/`text` that flows unbounded into memory and the model prompt
 *  (DOS / OOM). 96 MiB sits comfortably above the zip reader's 64 MiB total cap
 *  (`zip-store.ts` `ZIP_MAX_TOTAL_BYTES`) so legitimately large multi-part
 *  resources still pass, while a hostile hundreds-of-MB payload is refused as a
 *  typed `too-large` failure. Mirrors the zip reader's cap discipline; kept as a
 *  local constant because `@/mcp` does not import `@/tool` (slice isolation). */
export const RESOURCE_READ_MAX_CONTENT_CHARS = 96 * 1024 * 1024

/** The cumulative `text.length + blob.length` across all parsed content blocks.
 *  Pure, no allocation — used to enforce {@link RESOURCE_READ_MAX_CONTENT_CHARS}
 *  WITHOUT retaining/serializing the (potentially huge) payload first. */
export const resourceContentChars = (contents: readonly McpResourceContent[]): number => {
  let total = 0
  for (const c of contents) total += (c.text?.length ?? 0) + (c.blob?.length ?? 0)
  return total
}

/** Discriminated outcome of a capped `resources/read` parse:
 *   - `{ kind: "ok" }` — well-formed AND within the byte cap;
 *   - `{ kind: "malformed" }` — `contents` was not a `{contents:[...]}` array;
 *   - `{ kind: "too-large" }` — well-formed but the cumulative content exceeds
 *     {@link RESOURCE_READ_MAX_CONTENT_CHARS}. */
export type CappedResourceRead =
  | { readonly kind: "ok"; readonly contents: McpResourceContent[] }
  | { readonly kind: "malformed" }
  | { readonly kind: "too-large"; readonly chars: number }

/** Parse + size-gate a `resources/read` result. Reuses {@link parseResourceRead}
 *  for the shape narrowing, then refuses an over-cap payload with a typed
 *  `too-large` outcome (no unbounded allocation downstream). */
export const parseResourceReadCapped = (result: unknown): CappedResourceRead => {
  const parsed = parseResourceRead(result)
  if (parsed === null) return { kind: "malformed" }
  const chars = resourceContentChars(parsed)
  if (chars > RESOURCE_READ_MAX_CONTENT_CHARS) return { kind: "too-large", chars }
  return { kind: "ok", contents: parsed }
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
    if (out.length >= PARSE_MAX_LIST_ENTRIES) break // DoS bound — stop retaining
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
